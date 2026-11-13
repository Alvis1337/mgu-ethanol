// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Adapted from MGD4096/IDRIVE_GAUGE_APP tests/fake_appframework.cpp (PolyForm-Noncommercial); see idrive6/LICENSE.
#include "fake_appframework.hpp"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

FakeState g_fake;

namespace bmw {
template <> BasicString<char>::BasicString(const char* s) : m_data(strdup(s)) {}
template <> BasicString<char>::BasicString(const BasicString& o) : m_data(strdup(o.m_data)) {}
template <> BasicString<char>::~BasicString() { free(m_data); }
template <> BasicString<unsigned short>::BasicString(const unsigned short* s) {
    size_t n = 0;
    while (s[n]) ++n;
    m_data = (unsigned short*)malloc((n + 1) * sizeof(unsigned short));
    memcpy(m_data, s, (n + 1) * sizeof(unsigned short));
}
template <> BasicString<unsigned short>::~BasicString() { free(m_data); }

Runnable::~Runnable() {}

#define FAKE_SLOT_DEF(n) void PluginApp::s##n() { printf("FAKE slot %d\n", n); }
PluginApp::PluginApp(IDispatcher&, BasicString<char> n, unsigned, unsigned, RHMIInterfaceVersion, const Bundle&,
                     const Bundle&) {
    snprintf(name, sizeof(name), "%s", n.m_data);
}
PluginApp::~PluginApp() {}
FAKE_SLOT_DEF(2) FAKE_SLOT_DEF(3) FAKE_SLOT_DEF(4) FAKE_SLOT_DEF(5) FAKE_SLOT_DEF(6) FAKE_SLOT_DEF(7) FAKE_SLOT_DEF(8)
FAKE_SLOT_DEF(9) FAKE_SLOT_DEF(10) FAKE_SLOT_DEF(11) FAKE_SLOT_DEF(12) FAKE_SLOT_DEF(13) FAKE_SLOT_DEF(14)
FAKE_SLOT_DEF(15) FAKE_SLOT_DEF(16) FAKE_SLOT_DEF(17) FAKE_SLOT_DEF(18) FAKE_SLOT_DEF(19) FAKE_SLOT_DEF(20)
FAKE_SLOT_DEF(24) FAKE_SLOT_DEF(25) FAKE_SLOT_DEF(26) FAKE_SLOT_DEF(27) FAKE_SLOT_DEF(28) FAKE_SLOT_DEF(29)
FAKE_SLOT_DEF(30) FAKE_SLOT_DEF(31) FAKE_SLOT_DEF(32) FAKE_SLOT_DEF(33)
void PluginApp::onError(unsigned c, const BasicString<char>& t) { printf("FAKE base onError %u %s\n", c, t.m_data); }
bool PluginApp::onInit() { g_fake.baseOnInit++; return true; }
void PluginApp::onFinalize() { g_fake.baseOnFinalize++; }

void PluginApp::post(Runnable* r, unsigned ms) { g_fake.posted.push_back(std::make_pair(r, ms)); }

void PluginApp::updateModel(unsigned id, const BasicString<unsigned short>& t) {
    std::string out;
    for (const unsigned short* p = t.m_data; *p; ++p) {
        unsigned c = *p;
        if (c < 0x80) out += (char)c;
        else if (c < 0x800) { out += (char)(0xc0 | (c >> 6)); out += (char)(0x80 | (c & 0x3f)); }
        else { out += (char)(0xe0 | (c >> 12)); out += (char)(0x80 | ((c >> 6) & 0x3f)); out += (char)(0x80 | (c & 0x3f)); }
    }
    g_fake.modelText[id] = out;
    g_fake.modelWrites[id]++;
}

void PluginApp::cdsAddPropertyChangedEventHandler(BasicString<char>& n, unsigned, const CdsDelegate& d) {
    g_fake.cds[n.m_data] = d;
}
} // namespace bmw
