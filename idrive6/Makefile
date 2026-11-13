# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Ethanol PluginApp for BMW NBT Evo (ID5/ID6). Build layout follows MGD4096/IDRIVE_GAUGE_APP; see idrive6/LICENSE.
#
#   make check      host tests (pure logic + dlopen integration) with Linux g++ - no QNX, no car. Do this first.
#   make db         build the text/image DBs (python3 + Pillow)
#   make            cross-compile libEthanolApp.so for the unit (needs QNX SDP 6.5 + the car's framework libs)
#   make clean
#
# RHMI_LIBDIR must hold copies of the car's libAppFramework.A.so and libCoreFramework.A.so (opt/hmi/ID5/lib in a
# firmware dump). They are BMW's files, not part of this project; copy them from your own head unit.

QCC ?= qcc
RHMI_LIBDIR ?= ./lib
RHMI_LIBS = $(wildcard $(RHMI_LIBDIR)/libAppFramework.A.so $(RHMI_LIBDIR)/libCoreFramework.A.so)

PLUGIN_CXX      = $(QCC) -Vgcc_ntoarmv7le_gpp
PLUGIN_CXXFLAGS = -O2 -Wall -D_QNX_SOURCE -march=armv7-a -mfpu=vfpv3 -mfloat-abi=softfp -fPIC -I./src

.PHONY: all lib db check clean
all: lib db

lib: libEthanolApp.so

libEthanolApp.so: src/qnx_binding.cpp src/*.hpp
	@test -n "$(RHMI_LIBS)" || { echo "put libAppFramework.A.so and libCoreFramework.A.so from the car into $(RHMI_LIBDIR) (or set RHMI_LIBDIR)"; exit 1; }
	@echo [BUILD] $@
	$(PLUGIN_CXX) $(PLUGIN_CXXFLAGS) -shared -Wl,-soname,libEthanolApp.so -o $@ src/qnx_binding.cpp $(RHMI_LIBS) -Wl,--allow-shlib-undefined -lang-c++
	@echo [DONE] $@ - install with EthanolApp.manifest, EthanolApp.xml and the two zips into Plugins/EthanolApp

db:
	python3 make_db.py

check:
	$(MAKE) -C tests check

clean:
	rm -f libEthanolApp.so EthanolApp_ALL_Texts.zip EthanolApp_ALL_Images.zip
	rm -rf data_out __pycache__
	$(MAKE) -C tests clean
