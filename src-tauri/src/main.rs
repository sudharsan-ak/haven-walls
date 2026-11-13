// Prevent an extra console window when launching the release EXE on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    haven_walls_lib::run();
}
