// Default sample values for the bundled example document, so derived
// capabilities evaluate on first load. Format: { nodeId: { capability: value } }.
export const DEFAULT_SAMPLES_TEXT = JSON.stringify(
  {
    "GW-0001": { "pv.power": 3200, "meter.grid_power": -1200, "battery.power": 800 },
    "INV-0001": { "battery.soc": 67, "battery.capacity": 9500, "battery.charge_power_limit": 3600, "battery.target_soc": 100 },
    "INV-0002": { "battery.soc": 71, "battery.charge_power_limit": 3600 },
    "EVSE-0001": { "ev_charger.power": 7200 },
    "MTR-0001": { "meter.grid_voltage": 241.3 },
    "HP-0001": { "thermal.temperature": 21.5, "thermal.power": 950, "thermal.setpoint": 21 },
    "FOX-0001": { "battery.soc": 55, "battery.power_limit_max": 5000 },
  },
  null,
  2,
);
