// qnx_binding.cpp - the cable between NBT Evo's framework and app_core::render().
//
// PLACEHOLDER, ON PURPOSE. The first draft of this file guessed the framework API from a README and was
// wrong in the ways that matter. Having now read the reference app's real source, the true shape is:
//
//   * No BMW headers exist. The framework is bound by hand-declaring the mangled C++ symbols of
//     bmw::PluginApp / bmw::BasicString / the CDS delegate, linking against the car's libAppFramework.A.so and
//     libCoreFramework.A.so with --allow-shlib-undefined, and patching a copy of PluginApp's vtable at runtime
//     to install our onInit/onError/onFinalize. The library exports a `pluginAppInfo` struct (create/destroy
//     function pointers) that HmiMain3D finds with dlsym.
//   * CDS values arrive as UTF-16 JSON-ish TEXT, not numbers. sensors.fuel delivers
//     {"fuel":{"range":522,"reserve":0,"tanklevel":39}}; the handler narrows it to ASCII and pulls "tanklevel"
//     (litres) out. There is no ethanol property (see cds_keys.hpp) - ethanol stays manual.
//   * Rows are written with PluginApp::updateModel(modelId, utf16) on a ~500 ms posted Runnable; only changed
//     rows are rewritten.
//
// The decision logic and formatting for all of that already exist and are tested: app_core::render() turns the
// latest tank level + manual ethanol % into the row strings. This file's only job will be the cable:
//   subscribe sensors.fuel  ->  numField(text,"tanklevel")  ->  Inputs.fuelL  ->  render()  ->  updateModel rows.
//
// WHY IT IS NOT WRITTEN OUT HERE YET: that glue is a derivative of the reference app
// (MGD4096/IDRIVE_GAUGE_APP) and the NBT-AAD project, both PolyForm-Noncommercial-1.0.0. This repo is
// public-domain (Unlicense), so the derived binding must not be committed here until the licensing of this
// idrive6/ subtree is settled (see README "Licensing note"). Once decided, the binding lands either under
// PolyForm-Noncommercial with attribution, or as a clean-room implementation.
//
// Nothing here touches the car. The host tests (tests/run_tests.cpp) cover everything that does not.
