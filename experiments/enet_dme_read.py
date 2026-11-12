#!/usr/bin/env python3
# ruff: noqa
"""
enet_dme_read.py - READ-ONLY DoIP/UDS probe for reading ethanol content (and VIN / fuel type) from a
BMW over a USB-C -> ENET OBD2 cable. For your own car. Experimental (dev branch); not documented.

It connects to the car's gateway over DoIP (ISO 13400), maps which ECUs answer, then reads a short list
of identifiers from the DME (diagnostic address 0x12). It ONLY ever sends UDS service 0x22
(ReadDataByIdentifier). It never writes, codes, clears, or opens a non-default session - nothing that
could disturb a tuned DME.

This is the laptop-side ground truth: it tells us whether the DME reports ethanol at all, via which
identifier, and its scaling - which the in-dash app cannot get because the head unit's internal
diagnostic route does not reach the powertrain bus.

Setup (macOS):
  1. Plug the ENET cable into the OBD2 port and your Mac's USB-C. Ignition on (engine running is fine).
  2. It shows up as an Ethernet interface. The car's DoIP edge node assigns link-local (169.254.x.x)
     once the cable's activation pin is tied (ENET OBD cables do this). Leave the Mac's interface on
     DHCP / link-local (automatic). No manual IP needed in most cases.
  3. python3 -m pip install doipclient
  4. python3 enet_dme_read.py            # auto-discovers the car and sweeps
     python3 enet_dme_read.py --ip 169.254.x.x --gw 0x0010   # if auto-discovery times out

Output goes to the screen and to enet_dme_read.log next to this script. Send me that file.

What it reads (all UDS 0x22, read-only):
  F190 VIN, F150 SGBD index (ECU type)
  550D PROZENT_ALK_KRST  (BMW alcohol-in-fuel, DME8/MG1: 1 byte, 0..255 = 0..100 %)
  F452 OBD PID 52 via UDS (ethanol fuel %, 1 byte, 0..255 = 0..100 %)
  F451 fuel type (OBD PID 51 via UDS)
  5776 fuel quality adapted, 593A fuel+ethanol in oil, 4AD5 fuel temp (context)
  F400/F420/F440 supported-PID bitmaps
"""
import argparse
import datetime
import sys

LOG = None


def log(msg):
    line = msg if isinstance(msg, str) else repr(msg)
    print(line)
    if LOG:
        LOG.write(line + "\n")
        LOG.flush()


# UDS 0x22 identifiers to read from the DME, as [name, did, decoder].
def pct(b):
    return "%.1f %%" % (b[0] * 100.0 / 255.0) if b else "empty"


def ascii_(b):
    return "".join(chr(x) if 32 <= x < 127 else "." for x in b)


def u16(b):
    return (b[0] << 8 | b[1]) if len(b) >= 2 else None


def supported(base):
    def f(b):
        if len(b) < 4:
            return "short"
        bits = int.from_bytes(bytes(b[:4]), "big")
        want = {0x0C: "RPM", 0x2F: "fuel lvl", 0x51: "fuel type", 0x52: "ethanol"}
        out = []
        for pid, nm in want.items():
            if base < pid <= base + 0x20:
                i = pid - base - 1
                out.append("%02X=%s:%s" % (pid, nm, "Y" if (bits >> (31 - i)) & 1 else "n"))
        return "PIDs %02X-%02X %s" % (base + 1, base + 0x20, " ".join(out))
    return f


DME_READS = [
    ("VIN", 0xF190, ascii_),
    ("SGBD index (ECU type)", 0xF150, lambda b: bytes(b[:3]).hex().upper()),
    ("550D alcohol in fuel", 0x550D, lambda b: pct(b) + "  raw=" + bytes(b).hex().upper()),
    ("F452 OBD52 ethanol via UDS", 0xF452, lambda b: pct(b) + "  raw=" + bytes(b).hex().upper()),
    ("F451 fuel type", 0xF451, lambda b: "0x%02X raw=%s" % (b[0], bytes(b).hex().upper())),
    ("5776 fuel quality adapted", 0x5776, lambda b: "%.3f raw=%s" % (b[0] / 256.0, bytes(b).hex().upper())),
    ("593A fuel+ethanol in oil", 0x593A, lambda b: "%.1f g raw=%s" % ((u16(b) or 0) * 0.02133333, bytes(b).hex().upper())),
    ("4AD5 fuel temp", 0x4AD5, lambda b: "%.1f C raw=%s" % (b[0] * 0.75 - 48, bytes(b).hex().upper())),
    ("F400 supported", 0xF400, supported(0x00)),
    ("F420 supported", 0xF420, supported(0x20)),
    ("F440 supported", 0xF440, supported(0x40)),
]

NRC = {0x10: "generalReject", 0x11: "serviceNotSupported", 0x12: "subFunctionNotSupported",
       0x13: "badLength", 0x22: "conditionsNotCorrect", 0x31: "requestOutOfRange",
       0x33: "securityAccessDenied", 0x78: "responsePending", 0x7E: "notInSession", 0x7F: "notInSession"}

# Candidate target DoIP logical addresses to probe for a VIN, to learn which answer on this car.
# BMW usually maps the ECU diagnostic address into the DoIP logical address directly.
SWEEP = [0x12, 0x13, 0x10, 0x40, 0x60, 0x63, 0x29, 0x19]
NAMES = {0x12: "DME", 0x13: "DME2", 0x10: "Gateway ZGW", 0x40: "Body BDC",
         0x60: "Cluster KOMBI", 0x63: "Head unit", 0x29: "DSC", 0x19: "Transfer case LMV"}


def read_did(client, did, timeout=2.0):
    """Send UDS 22 <did>, return (ok, data_bytes) or (False, 'reason'). READ ONLY."""
    req = bytes([0x22, (did >> 8) & 0xFF, did & 0xFF])
    try:
        client.send_diagnostic(req)
        while True:
            resp = client.receive_diagnostic(timeout=timeout)
            if not resp:
                return (False, "no reply")
            if resp[0] == 0x7F and len(resp) >= 3:
                if resp[2] == 0x78:   # response pending, keep waiting
                    continue
                return (False, "NRC %02X %s" % (resp[2], NRC.get(resp[2], "")))
            if resp[0] == 0x62 and ((resp[1] << 8) | resp[2]) == did:
                return (True, list(resp[3:]))
            # not ours (another request's frame); keep reading briefly
    except Exception as e:
        return (False, "error: %s" % e)


def connect(ip, target, source):
    from doipclient import DoIPClient
    # routing activation happens on connect; default activation type 0 (default).
    return DoIPClient(ip, target, client_logical_address=source)


def main():
    global LOG
    ap = argparse.ArgumentParser()
    ap.add_argument("--ip", help="car DoIP IP (skip auto-discovery)")
    ap.add_argument("--gw", type=lambda x: int(x, 0), default=None, help="gateway logical address, e.g. 0x0010")
    ap.add_argument("--source", type=lambda x: int(x, 0), default=0x0E00, help="tester logical address")
    ap.add_argument("--dme", type=lambda x: int(x, 0), default=0x12, help="DME target logical address")
    args = ap.parse_args()
    LOG = open("enet_dme_read.log", "w")
    log("# enet_dme_read %s  (READ ONLY: UDS 0x22 only)" % datetime.datetime.now().isoformat())

    try:
        from doipclient import DoIPClient
    except ImportError:
        log("Missing dependency. Run:  python3 -m pip install doipclient")
        sys.exit(1)

    ip = args.ip
    if not ip:
        log("Discovering the car (DoIP vehicle announcement, up to 10 s)...")
        try:
            addr, announce = DoIPClient.await_vehicle_announcement(timeout=10)
            ip = addr[0]
            log("Found car at %s, gateway logical address 0x%04X, VIN %s"
                % (ip, announce.logical_address, getattr(announce, "vin", b"").decode(errors="replace")))
            if args.gw is None:
                args.gw = announce.logical_address
        except Exception as e:
            log("Auto-discovery failed (%s). Re-run with --ip and --gw." % e)
            sys.exit(1)

    # 1) which ECUs answer a VIN read? maps the DoIP routing on this car.
    log("\n== Sweep: VIN (22 F190) per target address ==")
    answered = []
    for tgt in SWEEP:
        try:
            c = connect(ip, tgt, args.source)
        except Exception as e:
            log("  %-16s @%02X  connect failed: %s" % (NAMES.get(tgt, "?"), tgt, e))
            continue
        ok, data = read_did(c, 0xF190)
        try:
            c.close()
        except Exception:
            pass
        if ok:
            answered.append(tgt)
            log("  %-16s @%02X  VIN %s" % (NAMES.get(tgt, "?"), tgt, ascii_(data)))
        else:
            log("  %-16s @%02X  %s" % (NAMES.get(tgt, "?"), tgt, data))

    # 2) full read of the DME.
    log("\n== DME @%02X reads ==" % args.dme)
    if args.dme not in answered:
        log("  (note: the DME did not answer the VIN sweep; reads below may all fail)")
    try:
        c = connect(ip, args.dme, args.source)
    except Exception as e:
        log("  connect to DME failed: %s" % e)
        sys.exit(1)
    for name, did, dec in DME_READS:
        ok, data = read_did(c, did)
        if ok:
            try:
                shown = dec(data)
            except Exception as e:
                shown = "decode err %s raw=%s" % (e, bytes(data).hex().upper())
            log("  %-28s 22 %04X -> %s" % (name, did, shown))
        else:
            log("  %-28s 22 %04X -> %s" % (name, did, data))
    try:
        c.close()
    except Exception:
        pass
    log("\nDone. Send me enet_dme_read.log")


if __name__ == "__main__":
    main()
