import { Injectable } from '@nestjs/common';
import { parsePythonFloatText } from '@app/platform/python-numeric.js';

const BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

@Injectable()
export class GeodataQueryMetrics {
  private readonly bucketCounts = BUCKETS.map(() => 0);
  private queryCount = 0;
  private queryDurationSeconds = 0;
  private slowQueries = 0;

  observePostgisQuery(durationSeconds: number): void {
    this.queryCount += 1;
    this.queryDurationSeconds += durationSeconds;
    BUCKETS.forEach((bound, index) => {
      if (durationSeconds <= bound) this.bucketCounts[index] += 1;
    });
    if (durationSeconds * 1000 >= slowQueryThresholdMs()) this.slowQueries += 1;
  }

  render(): string {
    const labels = '{query="bbox"';
    const lines = [
      '# HELP myota_geodata_postgis_query_duration_seconds PostGIS query duration in seconds.',
      '# TYPE myota_geodata_postgis_query_duration_seconds histogram',
      ...BUCKETS.map(
        (bound, index) =>
          `myota_geodata_postgis_query_duration_seconds_bucket${labels},le="${bound}"} ${this.bucketCounts[index]}`,
      ),
    ];
    lines.push(
      `myota_geodata_postgis_query_duration_seconds_bucket${labels},le="+Inf"} ${this.queryCount}`,
      `myota_geodata_postgis_query_duration_seconds_sum{query="bbox"} ${this.queryDurationSeconds}`,
      `myota_geodata_postgis_query_duration_seconds_count{query="bbox"} ${this.queryCount}`,
      '# HELP myota_geodata_slow_queries_total PostGIS queries exceeding the configured duration threshold.',
      '# TYPE myota_geodata_slow_queries_total counter',
      `myota_geodata_slow_queries_total{query="bbox"} ${this.slowQueries}`,
    );
    return `${lines.join('\n')}\n`;
  }
}

function slowQueryThresholdMs(): number {
  const raw = process.env.MYOTA_SLOW_QUERY_THRESHOLD_MS;
  if (raw === undefined) return 250;
  try {
    const value = parsePythonFloatText(raw);
    return Number.isNaN(value) ? 0 : Math.max(0, value);
  } catch {
    return 250;
  }
}
