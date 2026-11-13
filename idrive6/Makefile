# Makefile - build the Ethanol app for NBT Evo, and run host tests off the car.
#
#   make check      compile + run the pure-logic host tests (plain g++, no QNX, no car). Do this first.
#   make db         build the text/image data (python3 + Pillow)
#   make            cross-compile libEthanolApp.so for the unit (needs QNX SDP 6.5 + framework libs)
#   make clean
#
# The host tests cover everything that does not touch the car (blend, fuel, app_core). The car build needs
# the QNX toolchain and the two framework libraries copied off the unit into ./lib (see README).

# ---- host tests (run anywhere) ----
HOST_CXX  ?= g++
HOST_FLAGS = -std=gnu++98 -Wall -Wextra -O0 -g

.PHONY: check
check:
	$(HOST_CXX) $(HOST_FLAGS) -o run_tests tests/run_tests.cpp
	./run_tests

# ---- data build ----
.PHONY: db
db:
	python3 make_db.py

# ---- car build (QNX SDP 6.5) ----
# Pull libAppFramework.A.so and libCoreFramework.A.so off the unit (/opt/hmi/ID5/lib) into ./lib first.
QCC      ?= qcc
QCC_TGT  ?= -V4.4.2,gcc_ntoarmv7le
QCC_FLAGS = -std=gnu++98 -Wall -shared -fPIC -Isrc
LIBDIR   ?= lib

libEthanolApp.so: src/qnx_binding.cpp src/app_core.hpp src/blend.hpp src/fuel.hpp src/cds_keys.hpp
	$(QCC) $(QCC_TGT) $(QCC_FLAGS) -o $@ src/qnx_binding.cpp \
		-L$(LIBDIR) -lAppFramework -lCoreFramework

.PHONY: all
all: check libEthanolApp.so db

.PHONY: clean
clean:
	rm -f run_tests libEthanolApp.so
	rm -rf data_out __pycache__
