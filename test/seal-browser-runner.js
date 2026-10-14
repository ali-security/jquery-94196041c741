/*
 * Seal fork-CI driver: runs the jQuery QUnit suite (test/index.html) in
 * headless Chrome via puppeteer-core and reports results on stdout.
 *
 * Usage: node test/seal-browser-runner.js <url of test/index.html>
 *   CHROME_PATH       Chrome/Chromium executable (required)
 *   SEAL_MODULES      optional comma-separated QUnit modules; each one is run
 *                     in its own fresh page via `?module=<name>` (the way
 *                     upstream's TestSwarm job runs the suite, see the
 *                     `testswarm.tests` list in Gruntfile.js). Defaults to
 *                     DEFAULT_MODULES below. "*" runs every module in a
 *                     single page instead.
 *   SEAL_TEST_FILTER  optional QUnit `filter` (substring of "module: test")
 *   SEAL_SKIP_TESTS   optional "||"-separated list of exact "module: test" names
 *                     that are not registered (printed as SKIPPED)
 *
 * A page whose attempt ends before ANY test completed (requirejs "Load timeout
 * for modules" page error, no test started within STARTUP_TIMEOUT_MS, crash or
 * navigation error) is retried from a fresh page, up to MAX_RETRIES times.
 * A page with any completed test or any failed assertion is never retried.
 *
 * puppeteer-core is resolved via NODE_PATH (installed outside this tree).
 * Exit: 0 all green, 1 failures, 2 timeout / a page never finished.
 */
/* jshint node: true */
/* global Promise: false */
( function() {
"use strict";

var puppeteer = require( "puppeteer-core" );

var OVERALL_TIMEOUT_MS = 40 * 60 * 1000,
	MODULE_TIMEOUT_MS = 15 * 60 * 1000,
	STARTUP_TIMEOUT_MS = 120 * 1000,
	MAX_RETRIES = 2,

	// requirejs (external/requirejs) defaults to 7s per module script; test/
	// sets no waitSeconds of its own. Must stay below STARTUP_TIMEOUT_MS so a
	// stuck load still surfaces as a "Load timeout for modules" page error.
	REQUIRE_WAIT_SECONDS = 60,
	HEARTBEAT_MS = 120 * 1000,
	PREFIX = "__SEAL__",

	// Page#goto via a variable: jshint (es3) rejects the reserved word as a
	// dotted name and jscs (requireDotNotation) rejects a literal subscript.
	GOTO = "goto",

	// Every module test/data/testinit.js loads: Gruntfile.js `testswarm.tests`
	// plus "wrap" (missing from that list) and "ready" (test/unit/ready.js is
	// loaded synchronously by test/jquery.js).
	DEFAULT_MODULES = [
		"ready", "basic", "ajax", "attributes", "callbacks", "core", "css", "data",
		"deferred", "deprecated", "dimensions", "effects", "event", "manipulation",
		"offset", "queue", "selector", "serialize", "support", "traversing", "wrap"
	],
	baseUrl = process.argv[ 2 ],
	testFilter = process.env.SEAL_TEST_FILTER || "",
	moduleEnv = ( process.env.SEAL_MODULES || "" ).replace( /\s+/g, "" ),
	moduleList = moduleEnv === "*" ? [ "" ] :
		( moduleEnv ? moduleEnv.split( "," ) : DEFAULT_MODULES ),
	skipList = ( process.env.SEAL_SKIP_TESTS || "" ).split( "||" ).map( function( s ) {
		return s.replace( /^\s+|\s+$/g, "" );
	} ).filter( function( s ) {
		return s.length > 0;
	} );

if ( !baseUrl ) {
	console.error( "usage: node test/seal-browser-runner.js <url>" );
	process.exit( 2 );
}
if ( !process.env.CHROME_PATH ) {
	console.error( "CHROME_PATH is not set" );
	process.exit( 2 );
}

function pageUrl( moduleName ) {
	var u = baseUrl;
	if ( moduleName ) {
		u += ( u.indexOf( "?" ) >= 0 ? "&" : "?" ) + "module=" + encodeURIComponent( moduleName );
	}
	if ( testFilter ) {
		u += ( u.indexOf( "?" ) >= 0 ? "&" : "?" ) + "filter=" + encodeURIComponent( testFilter );
	}
	return u;
}

/*
 * Runs in every frame before any page script. Only the top frame is hooked:
 * the suite spawns many iframes, which reuse the parent's QUnit.
 */
function pageHook( skipNames, requireWaitSeconds ) {

	// Snapshot natives up front: ajax tests replace window.JSON with a
	// parse-only stub, and calling JSON.stringify from the reporter while it is
	// installed would throw (or wedge the suite).
	var nativeJSON = window.JSON,
		nativeStringify = nativeJSON.stringify,
		nativeConsole = window.console,
		nativeLog = nativeConsole.log,
		skip = {},
		hooked = false,
		qunitRef, i;

	if ( window.top !== window ) {
		return;
	}

	// require.js adopts a pre-existing non-function `require` as its config.
	// Top frame only: iframes fall back to parent.require only when
	// window.require is unset (test/jquery.js).
	if ( typeof window.require === "undefined" ) {
		window.require = { waitSeconds: requireWaitSeconds };
	}

	for ( i = 0; i < skipNames.length; i++ ) {
		skip[ skipNames[ i ] ] = true;
	}

	function emit( type, data ) {
		try {
			nativeLog.call( nativeConsole, "__SEAL__" +
				nativeStringify.call( nativeJSON, { type: type, data: data } ) );
		} catch ( e ) {
			try {
				nativeLog.call( nativeConsole, "__SEAL__" + nativeStringify.call( nativeJSON, {
					type: type, data: { error: "unserializable payload: " + e }
				} ) );
			} catch ( e2 ) {}
		}
	}

	function dump( value ) {
		var out;
		try {
			if ( qunitRef && qunitRef.dump ) {
				out = qunitRef.dump.parse( value );
			} else {
				out = String( value );
			}
		} catch ( e ) {
			try {
				out = String( value );
			} catch ( e2 ) {
				out = "<undumpable>";
			}
		}
		if ( typeof out === "string" && out.length > 2000 ) {
			out = out.slice( 0, 2000 ) + "...";
		}
		return out;
	}

	function hookQUnit( q ) {
		var origTest, wrappedTest;

		if ( hooked || !q || !q.config ) {
			return;
		}
		hooked = true;

		q.config.reorder = false;

		// Skip support: QUnit.test, QUnit.asyncTest (-> QUnit.test), the
		// ajaxTest/testIframe helpers (-> QUnit.test) and the window.test
		// global all end up here, where the current module name is known.
		origTest = q.test;
		wrappedTest = function( testName ) {
			var cur = q.config.currentModule,
				mod = cur && cur.name,
				key = ( mod ? mod + ": " : "" ) + testName;
			if ( skip[ key ] ) {
				emit( "skip", { name: key } );
				return;
			}
			return origTest.apply( this, arguments );
		};
		q.test = wrappedTest;
		window.test = wrappedTest;

		q.begin( function() {
			emit( "begin", {} );
		} );
		q.moduleStart( function( d ) {
			emit( "moduleStart", { name: d.name } );
		} );
		q.testStart( function( d ) {
			emit( "testStart", { name: d.name, module: d.module } );
		} );
		q.log( function( d ) {
			if ( d.result ) {
				return;
			}
			emit( "log", {
				module: d.module,
				name: d.name,
				message: d.message === undefined ? "" : String( d.message ),
				actual: dump( d.actual ),
				expected: dump( d.expected ),
				source: d.source === undefined ? "" : String( d.source )
			} );
		} );
		q.testDone( function( d ) {
			emit( "testDone", {
				name: d.name,
				module: d.module,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			} );
		} );
		q.done( function( d ) {
			emit( "done", {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
	}

	// QUnit 1.17 assigns window.QUnit once, after the object is fully built.
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( v ) {
			qunitRef = v;
			hookQUnit( v );
		}
	} );
}

function pad( s, n ) {
	s = String( s );
	while ( s.length < n ) {
		s += " ";
	}
	return s;
}

function main() {
	var browser, heartbeatTimer, overallTimer,
		finished = false,
		modules = {},
		moduleOrder = [],
		failedTests = 0,
		passedTests = 0,
		failedNames = [],
		skippedTests = [],
		pageProblems = [],
		retries = [],
		currentTest = null,
		lastProgress = Date.now(),
		lastHeartbeat = Date.now();

	function moduleStats( name ) {
		if ( !modules[ name ] ) {
			modules[ name ] = { tests: 0, failedTests: 0, assertions: 0, failedAssertions: 0 };
			moduleOrder.push( name );
		}
		return modules[ name ];
	}

	function printSummary() {
		var totalTests = passedTests + failedTests,
			sumAssertions = 0,
			sumFailedAssertions = 0;

		console.log( "" );
		console.log( "==================== SUMMARY ====================" );
		if ( skippedTests.length ) {
			console.log( "Skipped (not registered): " + skippedTests.length );
			skippedTests.forEach( function( n ) {
				console.log( "  SKIPPED: " + n );
			} );
		}
		console.log( pad( "module", 28 ) + pad( "tests", 8 ) + pad( "failed", 8 ) +
			pad( "assertions", 12 ) + "failed" );
		moduleOrder.forEach( function( name ) {
			var m = modules[ name ];
			sumAssertions += m.assertions;
			sumFailedAssertions += m.failedAssertions;
			console.log( pad( name, 28 ) + pad( m.tests, 8 ) + pad( m.failedTests, 8 ) +
				pad( m.assertions, 12 ) + m.failedAssertions );
		} );
		if ( failedNames.length ) {
			console.log( "Failed tests:" );
			failedNames.forEach( function( n ) {
				console.log( "  FAILED: " + n );
			} );
		}
		if ( retries.length ) {
			console.log( "Page retries (attempt ended before any test completed): " +
				retries.length );
			retries.forEach( function( n ) {
				console.log( "  " + n );
			} );
		}
		if ( pageProblems.length ) {
			console.log( "Page runs that did not finish cleanly:" );
			pageProblems.forEach( function( n ) {
				console.log( "  PROBLEM: " + n );
			} );
		}
		console.log( totalTests + " tests, " + ( sumAssertions - sumFailedAssertions ) +
			" assertions of " + sumAssertions + " passed, " + sumFailedAssertions +
			" failed (" + failedTests + " failed tests, " + skippedTests.length + " skipped, " +
			moduleList.length + " page run(s), " + retries.length + " retried)" );
	}

	function finish( code, reason ) {
		var closing;
		if ( finished ) {
			return;
		}
		finished = true;
		clearInterval( heartbeatTimer );
		clearTimeout( overallTimer );
		if ( reason ) {
			console.log( reason );
		}
		printSummary();
		console.log( "EXIT CODE " + code );
		closing = browser ? browser.close() : Promise.resolve();
		closing.then( null, function() {} ).then( function() {
			process.exit( code );
		} );

		// Do not let a hung browser.close() keep us alive.
		setTimeout( function() {
			process.exit( code );
		}, 15000 ).unref();
	}

	function onEvent( ev, run ) {
		var m,
			d = ev.data || {};

		switch ( ev.type ) {
		case "begin":
			run.begun = true;
			console.log( "QUnit begin" );
			break;
		case "moduleStart":
			console.log( "MODULE " + d.name );
			break;
		case "testStart":
			run.started++;
			currentTest = ( d.module ? d.module + ": " : "" ) + d.name;
			break;
		case "log":
			run.failedAssertions++;
			console.log( "    assertion failed: " + d.message );
			console.log( "      expected: " + d.expected );
			console.log( "      actual:   " + d.actual );
			if ( d.source ) {
				console.log( "      source:   " +
					String( d.source ).split( "\n" ).join( "\n                " ) );
			}
			break;
		case "testDone":
			lastProgress = Date.now();
			lastHeartbeat = lastProgress;
			currentTest = null;
			run.tests++;
			m = moduleStats( d.module || "(no module)" );
			m.tests++;
			m.assertions += d.total;
			m.failedAssertions += d.failed;
			if ( d.failed > 0 ) {
				m.failedTests++;
				failedTests++;
				failedNames.push( d.module + ": " + d.name );
			} else {
				passedTests++;
			}
			console.log( ( d.failed > 0 ? "FAIL" : "PASS" ) + " [" + d.module + "] " + d.name +
				" (" + d.passed + "/" + d.total + ")" );
			break;
		case "skip":

			// Every page loads every test file, so a skipped name is reported
			// once per page run; list it once.
			if ( skippedTests.indexOf( d.name ) < 0 ) {
				skippedTests.push( d.name );
				console.log( "SKIPPED: " + d.name );
			}
			break;
		case "done":
			console.log( "QUnit done: " + d.passed + "/" + d.total + " assertions passed, " +
				d.failed + " failed, runtime " + d.runtime + " ms" );
			run.end( "done", d );
			break;
		default:
			console.log( "unknown reporter event: " + ev.type );
		}
	}

	// One attempt at one test page. Resolves with { status, detail, run };
	// status is "done" when QUnit's done fired, else why the attempt ended.
	function runAttempt( label, pageAddr ) {
		var page, moduleTimer, startupTimer,
			run = { tests: 0, started: 0, failedAssertions: 0, begun: false, ended: false };

		return new Promise( function( resolve ) {
			run.end = function( status, detail ) {
				if ( run.ended ) {
					return;
				}
				run.ended = true;
				clearTimeout( moduleTimer );
				clearTimeout( startupTimer );
				resolve( { status: status, detail: detail } );
			};
			moduleTimer = setTimeout( function() {
				console.log( "TIMEOUT: " + label + " did not finish within " +
					( MODULE_TIMEOUT_MS / 60000 ) + " minutes" +
					( currentTest ? " (running: " + currentTest + ")" : "" ) );
				run.end( "timeout", "page did not finish within " +
					( MODULE_TIMEOUT_MS / 60000 ) + " minutes" );
			}, MODULE_TIMEOUT_MS );
			startupTimer = setTimeout( function() {
				if ( run.started === 0 ) {
					console.log( "STALLED: " + label + ": no test started within " +
						( STARTUP_TIMEOUT_MS / 1000 ) + "s (QUnit begin " +
						( run.begun ? "fired" : "never fired" ) + ")" );
					run.end( "no-start", "no test started within " +
						( STARTUP_TIMEOUT_MS / 1000 ) + "s" );
				}
			}, STARTUP_TIMEOUT_MS );

			browser.newPage().then( function( p ) {
				page = p;
				page.on( "console", function( msg ) {
					var ev,
						text = msg.text();
					if ( run.ended || text.indexOf( PREFIX ) !== 0 ) {
						return;
					}
					try {
						ev = JSON.parse( text.slice( PREFIX.length ) );
					} catch ( e ) {
						console.log( "unparseable reporter line: " + text.slice( 0, 500 ) );
						return;
					}
					onEvent( ev, run );
				} );
				page.on( "pageerror", function( err ) {
					var message = err && err.message ? err.message : String( err );
					if ( run.ended ) {
						return;
					}
					console.log( "PAGE ERROR: " + message );

					// The test files never finished loading, so QUnit.load() is
					// never called and the page would idle until MODULE_TIMEOUT_MS.
					if ( /Load timeout for modules/.test( message ) && run.started === 0 ) {
						run.end( "load-timeout", "requirejs load timeout before any test ran" );
					}
				} );
				page.on( "dialog", function( dialog ) {
					console.log( "DIALOG (" + dialog.type() + "): " + dialog.message() );
					dialog.dismiss().then( null, function() {} );
				} );
				page.on( "error", function( err ) {
					console.log( "ERROR: page crashed: " +
						( err && err.message ? err.message : String( err ) ) );
					run.end( "crash", "page crashed" );
				} );
				return page.evaluateOnNewDocument( pageHook, skipList, REQUIRE_WAIT_SECONDS );
			} ).then( function() {
				return page[ GOTO ]( pageAddr, { waitUntil: "load", timeout: 120000 } );
			} ).then( null, function( err ) {
				console.log( "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) );
				run.end( "error", "page load failed" );
			} );
		} ).then( function( result ) {
			result.run = run;
			return ( page ? page.close() : Promise.resolve() ).then( null, function() {} )
				.then( function() {
					return result;
				} );
		} );
	}

	// Run one test page, retrying (from a fresh page) attempts that ended
	// before any test completed and without any failed assertion.
	function runPage( moduleName ) {
		var label = moduleName || "(all modules)",
			pageAddr = pageUrl( moduleName ),
			attempts = MAX_RETRIES + 1;

		function attempt( n ) {
			console.log( "" );
			console.log( "=== PAGE RUN " + label +
				( n > 1 ? " (attempt " + n + "/" + attempts + ")" : "" ) + ": " + pageAddr );
			return runAttempt( label, pageAddr ).then( function( result ) {
				var run = result.run,
					line;
				if ( result.status === "done" ) {
					if ( run.tests === 0 ) {
						pageProblems.push( label + ": no tests ran" );
					}
					return;
				}
				if ( run.tests === 0 && run.failedAssertions === 0 && n < attempts ) {
					line = "RETRY " + label + ": " + result.detail + " (attempt " + ( n + 1 ) +
						"/" + attempts + ")";
					console.log( line );
					retries.push( line );
					return attempt( n + 1 );
				}
				pageProblems.push( label + ": QUnit done never fired (" + result.detail +
					"; " + run.tests + " test(s) completed, attempt " + n + "/" + attempts + ")" );
			} );
		}

		return attempt( 1 );
	}

	overallTimer = setTimeout( function() {
		finish( 2, "TIMEOUT: suite did not finish within " + ( OVERALL_TIMEOUT_MS / 60000 ) +
			" minutes" + ( currentTest ? " (running: " + currentTest + ")" : "" ) );
	}, OVERALL_TIMEOUT_MS );

	heartbeatTimer = setInterval( function() {
		var now = Date.now();
		if ( now - lastHeartbeat >= HEARTBEAT_MS ) {
			lastHeartbeat = now;
			console.log( "HEARTBEAT: no test completed in " +
				Math.round( ( now - lastProgress ) / 1000 ) + "s; running: " +
				( currentTest || "(none / between tests)" ) );
		}
	}, 5000 );

	console.log( "Base URL: " + baseUrl );
	console.log( "Page runs: " + moduleList.join( ", " ) );
	if ( skipList.length ) {
		console.log( "SEAL_SKIP_TESTS: " + skipList.length + " test(s)" );
	}

	puppeteer.launch( {
		executablePath: process.env.CHROME_PATH,
		headless: true,
		args: [ "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1",
			"--window-size=1280,1024" ]
	} ).then( function( b ) {
		var chain = Promise.resolve();
		browser = b;
		browser.on( "disconnected", function() {
			finish( 2, "ERROR: browser disconnected before the suite finished" );
		} );
		moduleList.forEach( function( name ) {
			chain = chain.then( function() {
				return runPage( name );
			} );
		} );
		return chain;
	} ).then( function() {
		if ( pageProblems.length ) {
			finish( 2 );
		} else {
			finish( failedTests === 0 && passedTests > 0 ? 0 : 1 );
		}
	} ).then( null, function( err ) {
		finish( 2, "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) );
	} );
}

main();
} )();
