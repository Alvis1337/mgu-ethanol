# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Host tests (Linux g++). From idrive6/: `make check`.
#   run_tests       pure logic: blend / fuel / app_core / cds_text / config
#   app_host_test   host build of src/qnx_binding.cpp, loaded with dlopen against the fake framework
OUT := build
CXX ?= g++
WARN := -Wall -Wextra

.PHONY: check clean
check: $(OUT)/run_tests $(OUT)/app_host_test $(OUT)/libEthanolApp.so
	$(OUT)/run_tests
	$(OUT)/app_host_test $(OUT)/libEthanolApp.so

$(OUT):
	mkdir -p $(OUT)

# pure-logic tests (C++98, same dialect as the car build)
$(OUT)/run_tests: run_tests.cpp ../src/blend.hpp ../src/fuel.hpp ../src/app_core.hpp ../src/cds_text.hpp ../src/config.hpp | $(OUT)
	$(CXX) -std=gnu++98 $(WARN) -I../src -o $@ run_tests.cpp

# host build of the plugin library (framework symbols resolved at dlopen against the fake)
$(OUT)/libEthanolApp.so: ../src/qnx_binding.cpp ../src/*.hpp | $(OUT)
	$(CXX) -std=gnu++98 $(WARN) -fPIC -shared -I../src -o $@ ../src/qnx_binding.cpp -ldl -lpthread

# -rdynamic: the library looks up bmw::Runnable's vtable with dlsym(RTLD_DEFAULT) and needs the fake's symbols.
$(OUT)/app_host_test: app_host_test.cpp fake_appframework.cpp fake_appframework.hpp | $(OUT)
	$(CXX) -std=gnu++11 $(WARN) -rdynamic -o $@ app_host_test.cpp fake_appframework.cpp -ldl

clean:
	rm -rf $(OUT)
