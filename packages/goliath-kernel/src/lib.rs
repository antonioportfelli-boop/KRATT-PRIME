//! User-space event model and analysis primitives. This crate does not load eBPF,
//! change network configuration, or perform defensive actions.

use std::net::{Ipv4Addr, Ipv6Addr};

/// Stable C-layout event shared with the eBPF program.
/// IPv4 addresses occupy the first four bytes; the remaining twelve are zero.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PacketEvent {
    pub ts_ns: u64,
    pub proto: u8,
    pub ip_version: u8,
    pub pad: [u8; 2],
    pub saddr: [u8; 16],
    pub daddr: [u8; 16],
    pub sport: u16,
    pub dport: u16,
    pub pkt_len: u32,
}

impl PacketEvent {
    pub fn source_ip(&self) -> Option<String> {
        match self.ip_version {
            4 => Some(Ipv4Addr::new(self.saddr[0], self.saddr[1], self.saddr[2], self.saddr[3]).to_string()),
            6 => Some(Ipv6Addr::from(self.saddr).to_string()),
            _ => None,
        }
    }

    pub fn destination_ip(&self) -> Option<String> {
        match self.ip_version {
            4 => Some(Ipv4Addr::new(self.daddr[0], self.daddr[1], self.daddr[2], self.daddr[3]).to_string()),
            6 => Some(Ipv6Addr::from(self.daddr).to_string()),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DynamicConfig {
    /// Exponential smoothing factor, constrained to [0, 1].
    pub alpha: f64,
    /// Positive finite scale used to derive a bounded modulation phase.
    pub modulation_const: f64,
    pub beta: f64,
    pub anomaly_threshold: f64,
}

impl Default for DynamicConfig {
    fn default() -> Self {
        Self { alpha: 0.85, modulation_const: 1024.0, beta: 0.05, anomaly_threshold: 0.1 }
    }
}

impl DynamicConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !self.alpha.is_finite() || !(0.0..=1.0).contains(&self.alpha) { return Err("alpha must be finite and in [0, 1]"); }
        if !self.modulation_const.is_finite() || self.modulation_const <= 0.0 { return Err("modulation_const must be positive and finite"); }
        if !self.beta.is_finite() || self.beta < 0.0 { return Err("beta must be finite and non-negative"); }
        if !self.anomaly_threshold.is_finite() || self.anomaly_threshold < 0.0 { return Err("anomaly_threshold must be finite and non-negative"); }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EngineSnapshot {
    pub kinetic_pressure: f64,
    pub previous_pressure: f64,
    pub resonance_score: f64,
    pub vortex_impact: f64,
    pub anomaly: bool,
}

#[derive(Debug)]
pub struct KineticResonanceEngine {
    resonance_freq: u64,
    kinetic_pressure: f64,
    last_kinetic_pressure: f64,
    vortex_angle_diff: f64,
    config: DynamicConfig,
}

impl KineticResonanceEngine {
    pub fn new(resonance_freq: u64, config: DynamicConfig) -> Result<Self, &'static str> {
        config.validate()?;
        Ok(Self { resonance_freq, kinetic_pressure: 0.0, last_kinetic_pressure: 0.0, vortex_angle_diff: 0.0, config })
    }

    pub fn update_config(&mut self, config: DynamicConfig) -> Result<(), &'static str> {
        config.validate()?;
        if !(config.beta * self.vortex_angle_diff).is_finite() {
            return Err("vortex impact would overflow");
        }
        self.config = config;
        Ok(())
    }

    pub fn update_vortex_angle_diff(&mut self, new_diff: f64) -> Result<(), &'static str> {
        if !new_diff.is_finite() { return Err("vortex angle difference must be finite"); }
        if !(self.config.beta * new_diff).is_finite() {
            return Err("vortex impact would overflow");
        }
        self.vortex_angle_diff = new_diff;
        Ok(())
    }

    pub fn update_kinetic_pressure(&mut self, velocity: f64, packet_weight: f64) -> Result<(), &'static str> {
        if !velocity.is_finite() || velocity < 0.0 || !packet_weight.is_finite() || packet_weight < 0.0 {
            return Err("velocity and packet weight must be finite and non-negative");
        }
        let input = velocity * packet_weight;
        if !input.is_finite() { return Err("kinetic input overflowed"); }
        let next = self.config.alpha * self.kinetic_pressure + (1.0 - self.config.alpha) * input;
        if !next.is_finite() { return Err("kinetic pressure overflowed"); }
        let modulation = (self.resonance_freq as f64).rem_euclid(self.config.modulation_const)
            / self.config.modulation_const;
        if !(next * (1.0 + modulation)).is_finite() {
            return Err("resonance score overflowed");
        }
        self.last_kinetic_pressure = self.kinetic_pressure;
        self.kinetic_pressure = next;
        Ok(())
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        let modulation = (self.resonance_freq as f64).rem_euclid(self.config.modulation_const) / self.config.modulation_const;
        let delta = (self.kinetic_pressure - self.last_kinetic_pressure).abs();
        EngineSnapshot {
            kinetic_pressure: self.kinetic_pressure,
            previous_pressure: self.last_kinetic_pressure,
            resonance_score: self.kinetic_pressure * (1.0 + modulation),
            vortex_impact: self.config.beta * self.vortex_angle_diff,
            anomaly: delta > self.config.anomaly_threshold,
        }
    }
}

/// Deterministic event-to-engine mapping. It reports analysis only; no packet
/// filtering, firewall changes, or automated response is performed.
pub fn process_packet_event(event: &PacketEvent, engine: &mut KineticResonanceEngine) -> Result<EngineSnapshot, &'static str> {
    if event.ip_version != 4 && event.ip_version != 6 { return Err("unsupported IP version"); }
    let packet_weight = match event.proto { 6 => 1.2, 17 => 1.0, _ => 0.8 };
    let velocity = event.pkt_len as f64 / 100.0;
    engine.update_kinetic_pressure(velocity, packet_weight)?;
    Ok(engine.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_event_abi_layout_is_stable() {
        assert_eq!(std::mem::size_of::<PacketEvent>(), 56);
        assert_eq!(std::mem::align_of::<PacketEvent>(), 8);
    }

    #[test]
    fn decodes_ipv4_and_ipv6_addresses() {
        let mut event = PacketEvent { ip_version: 4, ..Default::default() };
        event.saddr[..4].copy_from_slice(&[192, 0, 2, 1]);
        assert_eq!(event.source_ip().as_deref(), Some("192.0.2.1"));
        event.ip_version = 6;
        event.saddr = Ipv6Addr::LOCALHOST.octets();
        assert_eq!(event.source_ip().as_deref(), Some("::1"));
    }

    #[test]
    fn rejects_invalid_dynamic_configuration() {
        let bad = DynamicConfig { modulation_const: 0.0, ..Default::default() };
        assert!(KineticResonanceEngine::new(10, bad).is_err());
    }

    #[test]
    fn smooths_pressure_and_detects_large_delta() {
        let mut engine = KineticResonanceEngine::new(128, DynamicConfig::default()).unwrap();
        engine.update_kinetic_pressure(100.0, 1.0).unwrap();
        let snapshot = engine.snapshot();
        assert!(snapshot.kinetic_pressure > 0.0);
        assert!(snapshot.anomaly);
    }

    #[test]
    fn rejects_non_finite_input() {
        let mut engine = KineticResonanceEngine::new(1, DynamicConfig::default()).unwrap();
        assert!(engine.update_kinetic_pressure(f64::NAN, 1.0).is_err());
    }



    #[test]
    fn rejects_vortex_impact_overflow_without_mutating_state() {
        let config = DynamicConfig { beta: 2.0, ..Default::default() };
        let mut engine = KineticResonanceEngine::new(128, config).unwrap();
        assert!(engine.update_vortex_angle_diff(f64::MAX).is_err());
        assert_eq!(engine.snapshot().vortex_impact, 0.0);

        engine.update_vortex_angle_diff(2.0).unwrap();
        let overflowing = DynamicConfig { beta: f64::MAX, ..Default::default() };
        assert!(engine.update_config(overflowing).is_err());
        assert_eq!(engine.snapshot().vortex_impact, 4.0);
    }

    #[test]
    fn rejects_resonance_score_overflow_before_committing_pressure() {
        let config = DynamicConfig { alpha: 0.0, ..Default::default() };
        let mut engine = KineticResonanceEngine::new(1023, config).unwrap();
        assert!(engine.update_kinetic_pressure(1.0e308, 1.2).is_err());
        assert_eq!(engine.snapshot().kinetic_pressure, 0.0);
        assert_eq!(engine.snapshot().previous_pressure, 0.0);
        assert!(engine.snapshot().resonance_score.is_finite());
    }

    #[test]
    fn event_processing_is_analysis_only_and_deterministic() {
        let mut engine = KineticResonanceEngine::new(128, DynamicConfig::default()).unwrap();
        let event = PacketEvent { ip_version: 4, proto: 6, pkt_len: 1500, ..Default::default() };
        let snapshot = process_packet_event(&event, &mut engine).unwrap();
        assert!(snapshot.kinetic_pressure > 0.0);
        assert_eq!(snapshot.resonance_score, snapshot.kinetic_pressure * (1.0 + (128.0_f64 / 1024.0)));
    }
}
