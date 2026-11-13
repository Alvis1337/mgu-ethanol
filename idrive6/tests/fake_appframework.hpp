// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Host-test stand-in for libAppFramework.A.so / libCoreFramework.A.so: a bmw::PluginApp with the same 34-slot
// vtable layout, recording what the app does (updateModel texts, posted Runnables, CDS handlers). Not the real
// framework. Adapted from MGD4096/IDRIVE_GAUGE_APP tests/fake_appframework.hpp (PolyForm-Noncommercial); see
// idrive6/LICENSE.
#ifndef ETHANOL_FAKE_APPFRAMEWORK_HPP
#define ETHANOL_FAKE_APPFRAMEWORK_HPP
#include <stddef.h>
#include <string>
#include <vector>
#include <map>

namespace bmw {
class IDispatcher;
class Bundle;
enum RHMIInterfaceVersion { V1 = 1 };

template <typename T> class BasicString {
public:
    BasicString(const T* s);
    BasicString(const BasicString& o);
    ~BasicString();
    T* m_data;
};

class Runnable {
public:
    virtual ~Runnable();
    virtual void run() = 0;
};

template <typename R, typename A1, typename A2, typename A3, typename A4> struct Delegate {
    void* object;
    R (*stub)(void*, A1);
};
typedef Delegate<bool, const BasicString<unsigned short>&, void, void, void> CdsDelegate;

#define FAKE_SLOT(n) virtual void s##n();
class PluginApp {
public:
    PluginApp(IDispatcher&, BasicString<char> name, unsigned a, unsigned b, RHMIInterfaceVersion v, const Bundle&,
              const Bundle&);
    virtual ~PluginApp();
    FAKE_SLOT(2) FAKE_SLOT(3) FAKE_SLOT(4) FAKE_SLOT(5) FAKE_SLOT(6) FAKE_SLOT(7) FAKE_SLOT(8) FAKE_SLOT(9)
    FAKE_SLOT(10) FAKE_SLOT(11) FAKE_SLOT(12) FAKE_SLOT(13) FAKE_SLOT(14) FAKE_SLOT(15) FAKE_SLOT(16) FAKE_SLOT(17)
    FAKE_SLOT(18) FAKE_SLOT(19) FAKE_SLOT(20)
    virtual void onError(unsigned code, const BasicString<char>& text);   // slot 21
    virtual bool onInit();                                                // slot 22
    virtual void onFinalize();                                            // slot 23
    FAKE_SLOT(24) FAKE_SLOT(25) FAKE_SLOT(26) FAKE_SLOT(27) FAKE_SLOT(28) FAKE_SLOT(29) FAKE_SLOT(30) FAKE_SLOT(31)
    FAKE_SLOT(32) FAKE_SLOT(33)
    void post(Runnable* r, unsigned ms);
    void updateModel(unsigned modelId, const BasicString<unsigned short>& text);
    void cdsAddPropertyChangedEventHandler(BasicString<char>& name, unsigned id, const CdsDelegate& d);
    char name[64];
};
} // namespace bmw

struct FakeState {
    std::map<unsigned, std::string> modelText;
    std::map<unsigned, int> modelWrites;
    std::vector<std::pair<bmw::Runnable*, unsigned> > posted;
    std::map<std::string, bmw::CdsDelegate> cds;
    int baseOnInit, baseOnFinalize;
    FakeState() : baseOnInit(0), baseOnFinalize(0) {}
};
extern FakeState g_fake;
#endif
