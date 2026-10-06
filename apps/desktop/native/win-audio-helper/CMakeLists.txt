cmake_minimum_required(VERSION 3.20)
project(SloncordWinAudioHelper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(SloncordWinAudioHelper
  src/main.cpp
)

target_compile_definitions(SloncordWinAudioHelper PRIVATE UNICODE _UNICODE)
target_compile_options(SloncordWinAudioHelper PRIVATE /W3 /EHsc)

target_link_libraries(SloncordWinAudioHelper
  ole32
  oleaut32
  mmdevapi
  avrt
)

