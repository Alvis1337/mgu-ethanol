// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// cds_text.hpp - text helpers for NBT Evo CDS values (pure logic).
//
// CDS delivers each property as a small JSON-ish string in UTF-16 (e.g. sensors.fuel ->
// {"fuel":{"range":522,"reserve":0,"tanklevel":39}}). We narrow it to ASCII and pull a numeric field out by
// key. The narrow / utf8to16 / numField routines follow the approach in MGD4096/IDRIVE_GAUGE_APP's
// cds_values.hpp and NBT-AAD's cds_parse.hpp (PolyForm-Noncommercial); see idrive6/LICENSE. C++98 (GCC 4.4).
#ifndef IDRIVE6_CDS_TEXT_HPP
#define IDRIVE6_CDS_TEXT_HPP

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

namespace ethanol {

// UTF-16 (as the car delivers CDS values) -> ASCII; anything above 0x7f becomes '?'. Returns the length.
inline size_t narrow(const unsigned short* in, char* out, size_t n) {
    size_t i = 0;
    if (!out || n == 0) return 0;
    while (in && in[i] && i < n - 1) { out[i] = in[i] < 0x80 ? (char)in[i] : '?'; ++i; }
    out[i] = 0;
    return i;
}

// UTF-8 -> UTF-16 (BMP only; invalid sequence -> '?'). n = capacity of out in units, terminator included.
inline size_t utf8to16(const char* in, unsigned short* out, size_t n) {
    size_t o = 0;
    if (!out || n == 0) return 0;
    const unsigned char* p = (const unsigned char*)in;
    while (p && *p && o + 1 < n) {
        unsigned c = *p;
        if (c < 0x80) { out[o++] = (unsigned short)c; ++p; }
        else if ((c & 0xe0) == 0xc0 && (p[1] & 0xc0) == 0x80) { out[o++] = (unsigned short)(((c & 0x1f) << 6) | (p[1] & 0x3f)); p += 2; }
        else if ((c & 0xf0) == 0xe0 && (p[1] & 0xc0) == 0x80 && (p[2] & 0xc0) == 0x80) { out[o++] = (unsigned short)(((c & 0x0f) << 12) | ((p[1] & 0x3f) << 6) | (p[2] & 0x3f)); p += 3; }
        else { out[o++] = '?'; ++p; }
    }
    out[o] = 0;
    return o;
}

// Number after "<key>": in text. false when the key is missing, the value is not a number, or not finite.
// Accepts integers and decimals ("tanklevel":39, "temperatureExterior":14.0).
inline bool numField(const char* text, const char* key, double* out) {
    if (!text || !key || !out) return false;
    char pat[48];
    size_t kl = strlen(key);
    if (kl + 3 > sizeof(pat)) return false;
    pat[0] = '"';
    memcpy(pat + 1, key, kl);
    pat[kl + 1] = '"';
    pat[kl + 2] = 0;
    const char* p = strstr(text, pat);
    if (!p) return false;
    p += kl + 2;
    while (*p == ' ' || *p == ':') ++p;
    if (!(*p == '-' || *p == '.' || (*p >= '0' && *p <= '9'))) return false;
    char* end = NULL;
    double v = strtod(p, &end);
    if (end == p) return false;
    if (!(v > -1e9 && v < 1e9)) return false;   // also rejects NaN and infinity
    *out = v;
    return true;
}

}  // namespace ethanol

#endif
