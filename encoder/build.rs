// napi-rs build script — emits the platform-specific linker flags and the
// generated bindings.d.ts that the TS adapter imports.
extern crate napi_build;

fn main() {
    napi_build::setup();
}
