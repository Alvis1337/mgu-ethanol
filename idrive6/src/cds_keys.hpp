// cds_keys.hpp - the Car Data Service properties this app subscribes to, and the open question.
//
// On NBT Evo the reference gauge app reads these CDS properties (same call NbtAad uses,
// cdsAddPropertyChangedEventHandler): engine.temperature, engine.RPMSpeed, driving.speedActual,
// driving.gear, sensors.fuel, sensors.temperatureExterior. Those are confirmed to exist on at least some
// cars (unverified on ours).
//
// We need two things:
//   1) sensors.fuel         - tank contents, for the fill-up calculator. CONFIRMED name, units UNCONFIRMED
//                             (litres or percent). Set FUEL_IS_LITRES once seen on the car.
//   2) an ETHANOL property  - UNKNOWN. CDS may or may not publish fuel ethanol content to plugin apps.
//                             This is the whole experiment: if one of ETHANOL_CANDIDATES fires with a
//                             plausible value, iDrive 6 gives us live ethanol that MGU could not. If none
//                             ever fires, manual entry is the answer (same as the MGU app ended up).
//
// How to discover it on the car: subscribe to every candidate below, log whatever arrives to
// nbt-ethanol.log (qnx_binding.cpp does this), fill the tank with a known E-content, and see which
// property tracks it. Add names as we learn the CDS schema (dump it from the unit if possible).
#ifndef IDRIVE6_CDS_KEYS_HPP
#define IDRIVE6_CDS_KEYS_HPP

namespace ethanol {

// Confirmed property (name), units to be confirmed on the car.
static const char* CDS_FUEL = "sensors.fuel";
static const bool  FUEL_IS_LITRES = false;   // TODO: set true if sensors.fuel is litres; false = percent of tank

// Guesses to probe for ethanol/flex-fuel content. None confirmed. Harmless to subscribe to a property that
// does not exist (the handler simply never fires); we log the ones that do.
static const char* ETHANOL_CANDIDATES[] = {
    "sensors.fuelEthanol",
    "sensors.ethanol",
    "engine.fuelEthanol",
    "engine.ethanolContent",
    "fuel.ethanol",
    "fuel.alcoholContent",
    "driving.fuelEthanol",
    0  // sentinel
};

// Default scaling to assume for whichever ethanol property fires, until we see raw values. Most CDS floats
// are human units already (PERCENT); a 0..1 property would be RATIO. qnx_binding logs raw so we can tell.
// (Scaling enum lives in fuel.hpp.)

}  // namespace ethanol

#endif
