# Hardware Runtime validation gate
This branch adds regression tests around the existing v0.2.0 hardware contract. Discovery remains adapter-owned and read-only. Route selection is a proposal only; it does not load drivers, start inference, benchmark devices, or send data to remote providers.

Required CI: Node syntax check; focused hardware tests; full KRATT Core suite. Device integration must be tested separately on Linux, Windows, Android and macOS runners/devices before declaring platform support. Missing drivers and unavailable hardware must degrade to explicit unavailable states, never fabricated capability claims.
