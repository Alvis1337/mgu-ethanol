// cds_keys.hpp - the Car Data Service properties this app uses, and what we learned about ethanol.
//
// On NBT Evo an app reads the Car Data Service (CDS), not diagnostics. CDS hands each property as a small
// JSON-ish UTF-16 text (e.g. sensors.fuel -> {"fuel":{"range":522,"reserve":0,"tanklevel":39}}); the binding
// narrows it to ASCII and pulls a field out (see cds_text.hpp numField).
//
// ETHANOL: settled, and it is a NO. The authoritative CDS property list
// (https://bimmergestalt.github.io/BMWConnectedAnalysis/cds/) has NO property for ethanol content, flex-fuel
// %, alcohol content, fuel quality or fuel composition. The only fuel-type signal is engine.info.fuelType,
// an undecoded enum ("fuelType":4) that classifies petrol/diesel/etc - not an E-percentage. So iDrive 6
// cannot hand us live ethanol through the app data path, the same wall MGU hit - but now confirmed from the
// schema, not just a silent probe. Ethanol is entered by hand (app_core manual mode).
//
// FUEL LEVEL: this is the real win over MGU. sensors.fuel.tanklevel is the tank contents in LITRES, push-fed
// and confirmed in the schema. That is exactly what the fill-up calculator needs, and it was a struggle to
// get on MGU. So on iDrive 6 the calculator runs on a live, reliable tank level + a hand-entered ethanol %.
#ifndef IDRIVE6_CDS_KEYS_HPP
#define IDRIVE6_CDS_KEYS_HPP

namespace ethanol {

// Confirmed property and field. tanklevel is litres (schema: "tankLevel:Liters").
static const char* CDS_FUEL       = "sensors.fuel";
static const char* CDS_FUEL_FIELD = "tanklevel";
static const bool  FUEL_IS_LITRES = true;

// engine.info carries fuelType (enum, not an E-percent). We subscribe only to log its raw value once, in case
// a flex-fuel car populates something useful here - not used as the ethanol number.
static const char* CDS_ENGINE_INFO = "engine.info";
static const char* CDS_FUELTYPE_FIELD = "fuelType";

// No ethanol property exists in CDS (see header note). There is deliberately no candidate list to probe:
// the schema is authoritative and we are not going to tie up the app chasing a property that is not there.

}  // namespace ethanol

#endif
