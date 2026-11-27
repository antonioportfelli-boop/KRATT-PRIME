      p50_ms: result.duration_ms.p50,
      p95_ms: result.duration_ms.p95,
      p99_ms: result.duration_ms.p99,
      measurement_rounds: measurementRounds,
      throughput_cv_percent: result.throughput_variation.coefficient_of_variation_percent,
      audit_chain_ok: auditOk,
    }) + "\n");

    if (!auditOk || measured.errors > 0 || measured.successes !== iterations * measurementRounds) process.exitCode = 1;
  } finally {
    db.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

for (const evidenceCount of evidenceCounts) {
  for (const concurrency of concurrencyLevels) {
    await executeScenario(evidenceCount, concurrency);
  }
}