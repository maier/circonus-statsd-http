# circonus-statsd

StatsD backend for [Circonus](http://circonus.com). The existing graphite backend was used as a template.

## Use

1. Install [StatsD](https://github.com/etsy/statsd)
2. Copy `circonus.js` into `backends/` (where StatsD is installed)
3. Create HTTPTRAP check in Circonus
4. Configure Circonus backend (see below)
5. Start, or restart, StatsD 

## Configuration options

In the StatsD configuration file:

1. Add `"circonus"` to `backends: [...]` array
2. Add `circonus: {...}` section

```json
circonus: {
  check_url: ""
  , cert_url: ""
  , globalPrefix: ""
  , prefixCounter: ""
  , prefixTimer: ""
  , prefixGauge: ""
  , prefixSet: ""
  , sendTimerDerivatives: true
  , sendMemoryStats: true
}
```

option | required | type | description
------ | -------- | ---- | -----------
`check_url` | **yes** | string | HTTPTRAP check submission URL to which metrics will be sent
`cert_url` | no* | string | broker CA certificate URL [default: http://login.circonus.com/pki/ca.crt].<br />* Note: URL **must** be set for a _Circonus Inside_ installation.
`globalPrefix` | no | string | global prefix to use for sending metrics to Circonus [default: ""]
`prefixCounter` | no | string | prefix for counter metrics [default: "counters"]
`prefixTimer` | no | string | prefix for timer metrics [default: "timers"]
`prefixGauge` | no | string | prefix for gauge metrics [default: "gauges"]
`prefixSet` | no | string | prefix for set metrics [default: "sets"]
`sendTimerDerivatives` | no | boolean | send [standard StatsD derivatives](https://github.com/etsy/statsd/blob/master/docs/metric_types.md#timing) for timer metrics [default: true]
`sendMemoryStats` | no | boolean | send memory utilization metrics ([process.memoryUsage()](https://nodejs.org/api/process.html#process_process_memoryusage)) for StatsD process [default: true]

