'use strict';
// Erzeugt plausible Demo-Sensordaten als Random Walk.

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function walk(v, step, lo, hi) {
  return clamp(v + (Math.random() * 2 - 1) * step, lo, hi);
}

function round(v, digits = 1) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

class DemoSensor {
  constructor() {
    this.temperature = 14 + Math.random() * 4; // degC im Kanal
    this.humidity = 85 + Math.random() * 10; // %
    this.methane = 50 + Math.random() * 100; // ppm
    this.heartRate = 350 + Math.random() * 80; // bpm (Ratte: ~250-500)
    this.battery = 100; // %
    this.position = Math.random() * 100; // Meter entlang des Kanals
  }

  read() {
    this.temperature = walk(this.temperature, 0.3, 5, 30);
    this.humidity = walk(this.humidity, 1, 60, 100);
    // gelegentliche Gas-Spitzen
    this.methane = Math.random() < 0.05 ? this.methane + 300 : walk(this.methane * 0.97 + 3, 15, 0, 5000);
    this.heartRate = walk(this.heartRate, 15, 250, 500);
    this.battery = clamp(this.battery - Math.random() * 0.2, 0, 100);
    this.position = walk(this.position, 2, 0, 1000);
    return {
      temperature_c: round(this.temperature),
      humidity_pct: round(this.humidity),
      methane_ppm: round(this.methane, 0),
      heart_rate_bpm: round(this.heartRate, 0),
      battery_pct: round(this.battery),
      position_m: round(this.position),
    };
  }
}

module.exports = { DemoSensor };
