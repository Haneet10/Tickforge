cmake_minimum_required(VERSION 3.16)
project(tickforge_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(TF_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)

add_library(tickforge
  src/order_book.cpp
  src/market.cpp
  src/agents.cpp)
target_include_directories(tickforge PUBLIC include)
target_compile_options(tickforge PRIVATE -Wall -Wextra -Wpedantic)

if(TF_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

add_executable(tf_tests
  tests/main.cpp
  tests/test_price_index.cpp
  tests/test_order_book.cpp
  tests/test_fuzz.cpp
  tests/test_market.cpp)
target_link_libraries(tf_tests PRIVATE tickforge)

add_executable(tf_bench bench/bench_book.cpp)
target_link_libraries(tf_bench PRIVATE tickforge)

add_executable(tf_simulate tools/simulate.cpp)
target_link_libraries(tf_simulate PRIVATE tickforge)

enable_testing()
add_test(NAME engine COMMAND tf_tests)
