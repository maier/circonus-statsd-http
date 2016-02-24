/*eslint-env node */
/*eslint-disable no-multi-spaces, vars-on-top, no-inner-declarations, no-extra-parens, block-scoped-var, guard-for-in */

"use strict";

/*
 * Flush stats to Circonus (http://circonus.com/).
 *
 * To enable this backend, include 'circonus' in the backends configuration array:
 *
 *   backends: ['circonus']
 *
 * Options in config.js
 *
 * circonus: {
 *
 *   check_url:     REQUIRED string      - submission URL for the httptrap check for this host/instance
 *
 *   cert_url:      REQUIRED string|null - broker CA certificate URL [default: "http://login.circonus.com/pki/ca.crt"]
 *                                         *** URL will need to be set for an Circonus Inside installation ***
 *
 *   globalPrefix:         string - global prefix to use for sending stats to Circonus [default: ""]
 *   prefixCounter:        string - prefix for counter metrics [default: "counters"]
 *   prefixTimer:          string - prefix for timer metrics [default: "timers"]
 *   prefixGauge:          string - prefix for gauge metrics [default: "gauges"]
 *   prefixSet:            string - prefix for set metrics [default: "sets"]
 *   sendTimerDerivatives: bool   - send the standard statsd derivatives for timer metrics [default: true]
 *   sendMemoryStats:      bool   - send memory utilization metrics for statsd process [default: true]
 *   forceGC:              bool   - force garbage collection (helps node-core https tls object reclaim) [default: false] (start with --expose-gc)
 *
 * }
 *
 * This backend respects the global setting of keyNameSanitize
 *
 */

var https = require("https");
var http = require("http");
var url = require("url");
var util = require("util");

var BACKEND_NAME = "circonus";
var BACKEND_VERS = "1.0.0";
var MAX_REQUEST_TIME = 15; // seconds
var MILLISECOND = 1000;
var HTTP_OK = 200;

// this will be instantiated to the logger
var l = null;

var debug = null;
var check_url = null;
var check_cfg = null;
var flush_counts = null;

// prefix configuration
var globalPrefix = null;
var prefixCounter = null;
var prefixTimer = null;
var prefixGauge = null;
var prefixSet = null;
var prefixInternalMetrics = null;
var globalKeySanitize = true;

// other options
var sendTimerDerivatives = true;
var sendMemoryStats = true;
var forceGC = false;

// static
var metricDelimiter = "`";
var circonusPrefix = BACKEND_NAME;

// set up namespaces
var globalNamespace  = [];
var counterNamespace = [];
var timerNamespace   = [];
var gaugesNamespace  = [];
var setsNamespace    = [];

var circonusStats = {};

var get_ca_cert = function circonus_get_ca_cert(cert_url) {
    var client = null;
    var cert_obj = null;
    var reqTimerId = null;
    var req = null;

    function onReqError(err) {
        if (reqTimerId) {
            clearTimeout(reqTimerId);
        }

        if (debug) {
            l.log(err);
        }

        req = null;
    }

    function onReqTimeout() {
        if (reqTimerId) {
            clearTimeout(reqTimerId);
        }

        req.abort();

        if (debug) {
            l.log("Circonus timeout fetching CA cert");
        }

        req = null;
    }

    function onReqResponse(res) {
        var cert_data = "";

        res.on("data", function onData(data) {
            cert_data += data;
        });

        res.on("end", function onEnd() {
            var circonus_url = url.parse(check_url);

            if (reqTimerId) {
                clearTimeout(reqTimerId);
            }

            if (res.statusCode !== HTTP_OK) {
                throw new Error(util.format("Unable to retrieve Circonus Broker CA Cert %d", res.statusCode));
            }

            check_cfg = {
                hostname: circonus_url.host,
                path: circonus_url.path,
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                ca: [ cert_data ]
            };

            if (debug) {
                l.log(util.format("Loaded Circonus broker CA cert from %s", cert_url.href));
            }

            req = null;
        });
    }

    if (cert_url && check_url) {
        cert_obj = url.parse(cert_url);

        if (cert_obj.protocol === "https:") {
            client = https;
        } else {
            client = http;
        }

        reqTimerId = setTimeout(onReqTimeout, MAX_REQUEST_TIME * MILLISECOND);
        req = client.request(cert_url);
        req.on("error", onReqError);
        req.on("response", onReqResponse);
        req.end();
    }

};


var post_stats = function circonus_post_stats(metrics) {
    var last_flush = circonusStats.last_flush || 0;
    var last_exception = circonusStats.last_exception || 0;
    var flush_time = circonusStats.flush_time || 0;
    var flush_length = circonusStats.flush_length || 0;
    var metric_json = "";
    var starttime = Date.now();
    var namespace = globalNamespace.concat(prefixInternalMetrics);
    var req = null;
    var reqTimerId = null;

    function onReqError(err) {
        if (reqTimerId) {
            clearTimeout(reqTimerId);
        }
        if (debug) {
            l.log(util.format("Error sending to circonus: ", err));
        }
        req = null;
    }

    function onReqTimeout() {
        if (reqTimerId) {
            clearTimeout(reqTimerId);
        }
        req.abort();
        if (debug) {
            l.log("Timeout sending metrics to Circonus");
        }
        req = null;
    }

    function onReqResponse(res) {
        var result_json = "";

        res.on("data", function onData(chunk) {
            result_json += chunk;
        });

        res.on("end", function onEnd() {
            var result = null;

            if (reqTimerId) {
                clearTimeout(reqTimerId);
            }

            if (debug) {
                result = JSON.parse(result_json);
                l.log(util.format("%d metrics recieved by circonus", result.stats));
            }

            if (res.statusCode === HTTP_OK) {
                circonusStats.flush_time = (Date.now() - starttime);
                circonusStats.flush_length = metric_json.length;
                circonusStats.last_flush = Math.round(new Date().getTime() / MILLISECOND);
            } else {
                l.log(util.format("Unable to send metrics to Circonus", res.statusCode, result_json));
            }

            req = null;
            metric_json = null;

            if (forceGC && global.gc) {
                global.gc();
            }
        });
    }

    if (check_cfg) {
        try {
            metrics[ namespace.concat([ circonusPrefix, "last_exception" ]).join(metricDelimiter) ] = last_exception;
            metrics[ namespace.concat([ circonusPrefix, "last_flush" ]).join(metricDelimiter) ] = last_flush;
            metrics[ namespace.concat([ circonusPrefix, "flush_time" ]).join(metricDelimiter) ] = flush_time;
            metrics[ namespace.concat([ circonusPrefix, "flush_length" ]).join(metricDelimiter) ] = flush_length;
            metrics[ namespace.concat("num_stats").join(metricDelimiter) ] = Object.keys(metrics).length + 1; // +1 for this one...

            metric_json = JSON.stringify(metrics);

            reqTimerId = setTimeout(onReqTimeout, MAX_REQUEST_TIME * MILLISECOND);
            req = https.request(check_cfg);
            req.on("error", onReqError);
            req.on("response", onReqResponse);
            req.write(metric_json);
            req.end();

        } catch (err) {
            if (debug) {
                l.log(err);
            }
            circonusStats.last_exception = Math.round(new Date().getTime() / MILLISECOND);
        }
    }
};


var flush_stats = function circonus_flush(ts, metrics) {
    var starttime = Date.now();
    var key = null;
    var timer_data_key = null;
    var counters = metrics.counters;
    var gauges = metrics.gauges;
    var timers = metrics.timers;
    var sets = metrics.sets;
    var counter_rates = metrics.counter_rates;
    var timer_data = metrics.timer_data;
    var statsd_metrics = metrics.statsd_metrics;

    // Sanitize key if not done globally
    var sk = function sanitize_key(key_name) {
        if (globalKeySanitize) {
            return key_name;
        }
        return key_name.
            replace(/\s+/g, "_").
            replace(/\//g, "-").
            replace(/[^a-zA-Z_\-0-9\.\`]/g, "");
    };

    var namespace = null;
    var the_key = null;
    var stats = {};

    for (key in counters) {
        var value = counters[key];
        var valuePerSecond = counter_rates[key]; // pre-calculated "per second" rate

        the_key = sk(key);
        namespace = counterNamespace.concat(the_key);
        stats[namespace.concat("rate").join(metricDelimiter)] = valuePerSecond;
        if (flush_counts) {
            stats[namespace.concat("count").join(metricDelimiter)] = value;
        }
    }

    // histogram timer data
    for (key in timers) {
        namespace = timerNamespace.concat(sk(key));
        the_key = namespace.join(metricDelimiter);
        stats[the_key] = { _type: "i", _value: timers[key] };
    }

    if (sendTimerDerivatives) {
        // the derivative metrics from timers
        for (key in timer_data) {
            namespace = timerNamespace.concat(sk(key));
            the_key = namespace.join(metricDelimiter);
            for (timer_data_key in timer_data[key]) {
                if (typeof timer_data[key][timer_data_key] === "number") {
                    stats[the_key + metricDelimiter + timer_data_key] = timer_data[key][timer_data_key];
                } else {
                    for (var timer_data_sub_key in timer_data[key][timer_data_key]) {
                        if (debug) {
                            l.log(timer_data[key][timer_data_key][timer_data_sub_key].toString());
                        }
                        stats[the_key + metricDelimiter + timer_data_key + metricDelimiter + timer_data_sub_key] =
                            timer_data[key][timer_data_key][timer_data_sub_key];
                    }
                }
            }
        }
    }

    for (key in gauges) {
        stats[ gaugesNamespace.concat(sk(key)).join(metricDelimiter) ] = gauges[ key ];
    }

    for (key in sets) {
        stats[ setsNamespace.concat([ sk(key), "count" ]).join(metricDelimiter) ] = sets[ key ].size();
    }

    namespace = globalNamespace.concat(prefixInternalMetrics);
    stats[namespace.concat([ circonusPrefix, "calculation_time" ]).join(metricDelimiter)] = (Date.now() - starttime);
    for (key in statsd_metrics) {
        stats[namespace.concat(key).join(metricDelimiter)] = statsd_metrics[key];
    }

    if (sendMemoryStats) {
        stats[ namespace.concat("memory").join(metricDelimiter) ] = process.memoryUsage();
    }

    post_stats(stats);

};

var backend_status = function circonus_status(writeCb) {
    var stat = null;

    for (stat in circonusStats) {
        if (circonusStats.hasOwnProperty(stat)) {
            writeCb(null, BACKEND_NAME, stat, circonusStats[stat]);
        }
    }
};

exports.init = function circonus_init(startup_time, config, events, logger) {
    debug = config.debug;
    l = logger;
    config.circonus = config.circonus || {};
    check_url = config.circonus.check_url || null;
    globalPrefix = config.circonus.globalPrefix || "";
    prefixCounter = config.circonus.prefixCounter || "counters";
    prefixTimer = config.circonus.prefixTimer || "timers";
    prefixGauge = config.circonus.prefixGauge || "gauges";
    prefixSet = config.circonus.prefixSet || "sets";
    prefixInternalMetrics = config.prefixInternalMetrics || "statsd";
    sendTimerDerivatives = config.circonus.sendTimerDerivatives || true;
    sendMemoryStats = config.circonus.sendMemoryStats || true;
    forceGC = config.circonus.forceGC || false;

    if (check_url === null) {
        l.log("No check URL defined for Circonus, backend disabled.");
    }

    get_ca_cert(url.parse(config.circonusCACertURL || "http://login.circonus.com/pki/ca.crt"));

    if (globalPrefix !== "") {
        globalNamespace.push(globalPrefix);
        counterNamespace.push(globalPrefix);
        timerNamespace.push(globalPrefix);
        gaugesNamespace.push(globalPrefix);
        setsNamespace.push(globalPrefix);
    }

    if (prefixCounter !== "") {
        counterNamespace.push(prefixCounter);
    }
    if (prefixTimer !== "") {
        timerNamespace.push(prefixTimer);
    }
    if (prefixGauge !== "") {
        gaugesNamespace.push(prefixGauge);
    }
    if (prefixSet !== "") {
        setsNamespace.push(prefixSet);
    }

    circonusStats.last_flush = startup_time;
    circonusStats.last_exception = startup_time;
    circonusStats.flush_time = 0;
    circonusStats.flush_length = 0;

    globalKeySanitize = config.keyNameSanitize || true;

    flush_counts = config.flush_counts || true;

    events.on("flush", flush_stats);
    events.on("status", backend_status);

    if (debug) {
        l.log(util.format("Backend %s v%s loaded.", BACKEND_NAME, BACKEND_VERS));
    }

    return true;
};
