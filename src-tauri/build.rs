// Pre-built LUT files are committed to bundle_dist/luts/ and shipped with the app.
// Build script copies manifest metadata into OUT_DIR.

use std::env;
use std::fs;
use std::path::PathBuf;

struct LutSpec {
    slug: &'static str,
    config_slug: &'static str,
    config_label: &'static str,
    display: &'static str,
    view: &'static str,
    lut_input_max: f32,
}

impl LutSpec {
    fn label(&self) -> String {
        let disp_short = self
            .display
            .trim_end_matches(" - Display")
            .trim_end_matches("- Display")
            .to_string();
        format!("{} | {} | {}", self.config_label, disp_short, self.view)
    }
}

fn main() {
    tauri_build::build();

    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
        Ok(v) => PathBuf::from(v),
        Err(_) => return,
    };

    let out_dir = match env::var("OUT_DIR") {
        Ok(v) => PathBuf::from(v),
        Err(_) => return,
    };

    // Pre-baked LUTs shipped with the repo.
    let bundle_luts_dir = manifest_dir
        .parent()
        .map(|p| p.join("bundle_dist").join("luts"))
        .unwrap_or_else(|| out_dir.join("luts"));

    let out_luts_dir = out_dir.join("luts");
    let _ = fs::create_dir_all(&out_luts_dir);

    // -----------------------------------------------------------------
    // Hardcoded LUT list. Slugs must match the .bin filenames in
    // bundle_dist/luts/. Pre-bake them once (via Python+OCIO) and
    // commit to the repo; the build script just copies them to OUT_DIR.
    // -----------------------------------------------------------------
    let to_bake: Vec<LutSpec> = vec![
        // identity LUTs
        LutSpec {
            slug: "Linear_sRGB",
            config_slug: "",
            config_label: "Linear sRGB",
            display: "",
            view: "",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "Raw",
            config_slug: "",
            config_label: "Raw",
            display: "",
            view: "",
            lut_input_max: 1.0,
        },
        // ACES 1.3 CG
        LutSpec {
            slug: "ACES_1_3_CG__sRGB_Display__ACES_1_0_SDR_Video",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "sRGB - Display",
            view: "ACES 1.0 - SDR Video",
            lut_input_max: 16.29,
        },
        LutSpec {
            slug: "ACES_1_3_CG__sRGB_Display__Un_tone_mapped",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "sRGB - Display",
            view: "Un-tone-mapped",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "ACES_1_3_CG__sRGB_Display__Raw",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "sRGB - Display",
            view: "Raw",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "ACES_1_3_CG__Rec_1886_Rec_709_Display__ACES_1_0_SDR_Video",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "Rec.1886 Rec.709 - Display",
            view: "ACES 1.0 - SDR Video",
            lut_input_max: 16.29,
        },
        LutSpec {
            slug: "ACES_1_3_CG__Rec_1886_Rec_709_Display__Un_tone_mapped",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "Rec.1886 Rec.709 - Display",
            view: "Un-tone-mapped",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "ACES_1_3_CG__Rec_1886_Rec_709_Display__Raw",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "Rec.1886 Rec.709 - Display",
            view: "Raw",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "ACES_1_3_CG__Rec_2100_PQ_Display__ACES_1_1_HDR_Video_1000_nits_Rec_2020_lim",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "Rec.2100-PQ - Display",
            view: "ACES 1.1 - HDR Video (1000 nits & Rec.2020 lim)",
            lut_input_max: 16.29,
        },
        LutSpec {
            slug: "ACES_1_3_CG__Rec_2100_PQ_Display__Un_tone_mapped",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "Rec.2100-PQ - Display",
            view: "Un-tone-mapped",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "ACES_1_3_CG__Rec_2100_PQ_Display__Raw",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "Rec.2100-PQ - Display",
            view: "Raw",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "ACES_1_3_CG__ST2084_P3_D65_Display__ACES_1_1_HDR_Video_1000_nits_P3_lim",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "ST2084-P3-D65 - Display",
            view: "ACES 1.1 - HDR Video (1000 nits & P3 lim)",
            lut_input_max: 16.29,
        },
        LutSpec {
            slug: "ACES_1_3_CG__ST2084_P3_D65_Display__Un_tone_mapped",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "ST2084-P3-D65 - Display",
            view: "Un-tone-mapped",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "ACES_1_3_CG__ST2084_P3_D65_Display__Raw",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "ST2084-P3-D65 - Display",
            view: "Raw",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "ACES_1_3_CG__P3_D65_Display__ACES_1_0_SDR_Cinema",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "P3-D65 - Display",
            view: "ACES 1.0 - SDR Cinema",
            lut_input_max: 16.29,
        },
        LutSpec {
            slug: "ACES_1_3_CG__P3_D65_Display__Un_tone_mapped",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "P3-D65 - Display",
            view: "Un-tone-mapped",
            lut_input_max: 1.0,
        },
        LutSpec {
            slug: "ACES_1_3_CG__P3_D65_Display__Raw",
            config_slug: "ACES_1_3_CG",
            config_label: "ACES 1.3 CG",
            display: "P3-D65 - Display",
            view: "Raw",
            lut_input_max: 1.0,
        },
    ];

    // Copy pre-baked .bin files to OUT_DIR for runtime loading.
    // bundle_dist/luts/ is the canonical source-of-truth.
    let mut copied = 0;
    let mut missing = 0;
    for entry in &to_bake {
        let src = bundle_luts_dir.join(format!("{}.bin", entry.slug));
        let dst = out_luts_dir.join(format!("{}.bin", entry.slug));
        if src.exists() {
            if let Err(e) = fs::copy(&src, &dst) {
                println!(
                    "cargo:warning=Failed to copy {} -> {}: {}",
                    src.display(),
                    dst.display(),
                    e
                );
            } else {
                copied += 1;
            }
        } else {
            println!(
                "cargo:warning=LUT {}.bin not found in {} -- runtime will generate on-demand",
                entry.slug,
                bundle_luts_dir.display()
            );
            missing += 1;
        }
    }
    println!(
        "cargo:warning=Pre-built LUTs: {} copied to OUT_DIR, {} missing",
        copied,
        missing
    );

    // Write lut_manifest.rs consumed by main.rs at compile time.
    let manifest_path = out_dir.join("lut_manifest.rs");
    let mut src = String::new();
    src.push_str("// Auto-generated by build.rs -- do not edit by hand.\n\n");
    src.push_str("#[derive(Copy, Clone)]\n");
    src.push_str("pub struct LutEntry {\n");
    src.push_str("    pub slug: &'static str,\n");
    src.push_str("    pub config_slug: &'static str,\n");
    src.push_str("    pub config_label: &'static str,\n");
    src.push_str("    pub display: &'static str,\n");
    src.push_str("    pub view: &'static str,\n");
    src.push_str("    pub label: &'static str,\n");
    src.push_str("    pub lut_input_max: f32,\n");
    src.push_str("    pub is_identity: bool,\n");
    src.push_str("}\n\n");
    src.push_str("pub const OCIO_MODES: &[LutEntry] = &[\n");
    for entry in &to_bake {
        let is_identity = entry.config_slug.is_empty();
        src.push_str(&format!(
            "    LutEntry {{ slug: \"{}\", config_slug: \"{}\", config_label: \"{}\", display: \"{}\", view: \"{}\", label: \"{}\", lut_input_max: {:.4}_f32, is_identity: {}, }},\n",
            entry.slug,
            entry.config_slug.replace('\\', "\\\\").replace('"', "\\\""),
            entry.config_label.replace('\\', "\\\\").replace('"', "\\\""),
            entry.display.replace('\\', "\\\\").replace('"', "\\\""),
            entry.view.replace('\\', "\\\\").replace('"', "\\\""),
            entry.label().replace('\\', "\\\\").replace('"', "\\\""),
            entry.lut_input_max,
            is_identity,
        ));
    }
    src.push_str("];\n");
    fs::write(&manifest_path, src).expect("write lut_manifest.rs");

    // =================================================================
    // Phase 2: Real OpenEXR C++ API bridge. Compile exr_cpp_bridge.cpp +
    // link against the vcpkg OpenEXR + Imath + zlib + OpenEXRCore libs to
    // produce exr_cpp_bridge.dll (replaces the Phase 1 dummy).
    //
    // We use cc's `compile(name)` flow which handles cl.exe invocation,
    // but we must:
    //   1. Stop cc from also linking into the host crate (we want a DLL,
    //      not a static lib).
    //   2. Add /LD so cl.exe produces a DLL.
    //   3. Pass /link arguments after the source file so MSVC forwards
    //      the .lib imports for OpenEXR/Imath/etc. to link.exe.
    //   4. Add -I include paths for OpenEXR/Imath headers.
    //   5. Add LIB env entries so link.exe finds the import libs.
    //
    // Pivot rationale (from V1 lessons): building as a DLL means we get
    // proper DLL-to-DLL linking — the import libs only need __imp_ thunks,
    // the actual symbol resolution happens when the runtime LoadLibrary
    // chain pulls in OpenEXR-3_4.dll / Imath-3_2.dll.
    // =================================================================
    let out_path = std::path::PathBuf::from(&out_dir);
    let dll_path = out_path.join("exr_cpp_bridge.dll");
    let lib_path = out_path.join("exr_cpp_bridge.lib");

    // vcpkg layout (x64-windows). Override via env vars if needed.
    let vcpkg_root = std::env::var("VCPKG_INSTALLED_DIR")
        .unwrap_or_else(|_| "C:/vcpkg/installed/x64-windows".to_string());
    let vcpkg_include = format!("{}/include", vcpkg_root);
    let vcpkg_lib = format!("{}/lib", vcpkg_root);

    let mut compile_build = cc::Build::new();
    compile_build
        .file("src/exr_cpp_bridge.cpp")
        .flag_if_supported("/std:c++17")
        .flag_if_supported("/EHsc")
        .flag_if_supported("/O2")
        .flag_if_supported("/LD")
        // IMATH_DLL makes Imath headers use __declspec(dllimport) on
        // exported symbols like `imath_half_to_float_table`. Without this
        // our .obj would emit direct (non-__imp_) references, which the
        // MSVC linker can't resolve against Imath-3_2.lib (an import lib).
        .flag_if_supported("/DIMATH_DLL")
        // SIMD and optimization flags for faster EXR decode (2026-07-13 performance optimization)
        .flag_if_supported("/arch:AVX2")       // Enable AVX2 (Intel Haswell+, AMD Zen+) - faster F16C, ZIP
        .flag_if_supported("/Oi")               // Use intrinsic functions - faster half-float conversion
        .flag_if_supported("/Ob2")              // Inline expansion - better optimization
        .flag_if_supported("/Ot")               // Favor fast code - faster EXR decode
        .flag_if_supported("/fp:fast")          // Fast floating-point - safe for decode output
        // NOTE: /GL (whole program optimization) intentionally NOT enabled
        // because it causes issues with mixed C++/Rust FFI and slows incremental builds.
        // vcpkg puts headers in `<vcpkg>/include/<package>/...`, so we need
        // the include base dir, NOT the subdirectory. Then includes like
        // `<ImfRgbaFile.h>` and `<Imath/ImathBox.h>` both resolve.
        .include(&vcpkg_include)
        .include(format!("{}/OpenEXR", vcpkg_include))
        .include(format!("{}/Imath", vcpkg_include))
        .include(format!("{}/IlmBase", vcpkg_include));

    // Belt-and-suspenders: explicit /I flags.
    compile_build
        .flag(format!("/I{}", vcpkg_include))
        .flag(format!("/I{}/OpenEXR", vcpkg_include))
        .flag(format!("/I{}/Imath", vcpkg_include))
        .flag(format!("/I{}/IlmBase", vcpkg_include));

    let compiler = compile_build
        .try_get_compiler()
        .expect("cc: failed to discover C++ compiler for Phase 2 bridge");

    let mut cl_cmd = compiler.to_command();
    cl_cmd.current_dir(manifest_dir.as_path());

    // We need both cl.exe args (compile) AND link.exe args (link to DLL),
    // with correct arg ordering per MSVC conventions:
    //   cl.exe [flags] src/exr_cpp_bridge.cpp /c /Fo:<obj> /link [flags...]
    let obj_path = out_path.join("exr_cpp_bridge.obj");

    cl_cmd
        .arg("src/exr_cpp_bridge.cpp")
        .arg("/c")
        .arg(format!("/Fo:{}", obj_path.display()));

    let output = cl_cmd
        .output()
        .expect("failed to invoke cl.exe for Phase 2 compile");

    if !output.status.success() || !obj_path.exists() {
        eprintln!(
            "[exr_cpp_bridge] Phase 2 compile FAILED. status={}",
            output.status
        );
        eprintln!("[exr_cpp_bridge] --- stdout ---");
        eprintln!("{}", String::from_utf8_lossy(&output.stdout));
        eprintln!("[exr_cpp_bridge] --- stderr ---");
        eprintln!("{}", String::from_utf8_lossy(&output.stderr));
        panic!("Phase 2 exr_cpp_bridge compile failed");
    }

    // -----------------------------------------------------------------
    // Step 2: link.exe /DLL to build the .dll
    //
    // We can't use cc::Build for this — cc's flow always finishes with
    // an .a / .lib static archive. Instead we invoke link.exe directly
    // using the LIB env already set (cc discovered it via vswhom).
    // -----------------------------------------------------------------
    let link_exe = find_link_exe();
    if !link_exe.exists() {
        panic!("link.exe not found");
    }

    let link_status = std::process::Command::new(&link_exe)
        .arg("/nologo")
        .arg("/DLL")
        .arg(format!("/OUT:{}", dll_path.display()))
        .arg(format!("/IMPLIB:{}", lib_path.display()))
        .arg("/LIBPATH:".to_string() + &vcpkg_lib)
        .arg("OpenEXR-3_4.lib")
        .arg("Imath-3_2.lib")
        .arg("OpenEXRCore-3_4.lib")
        .arg("IlmThread-3_4.lib")
        .arg("Iex-3_4.lib")
        // vcpkg provides deflate.lib (not zlib.lib) in this build.
        .arg("deflate.lib")
        .arg(&obj_path)
        .current_dir(manifest_dir.as_path())
        // Forward MSVC env captured by cc during toolchain discovery.
        // cc::Tool::env() returns the exact LIB/INCLUDE/PATH the host
        // build uses — link.exe needs LIB to resolve msvcprt.lib etc.
        .envs(compiler.env().iter().map(|(k, v)| {
            (k.to_os_string(), v.to_os_string())
        }))
        .status()
        .expect("failed to invoke link.exe for Phase 2 bridge");

    if !link_status.success() || !dll_path.exists() {
        eprintln!(
            "[exr_cpp_bridge] Phase 2 link FAILED. status={}",
            link_status
        );
        panic!("Phase 2 exr_cpp_bridge link failed (dll not produced)");
    }

    println!(
        "cargo:warning=[exr_cpp_bridge] Phase 2 build OK: DLL at {}",
        dll_path.display()
    );

    println!("cargo:rerun-if-changed=src/exr_cpp_bridge.cpp");
    println!("cargo:rerun-if-changed=src/exr_cpp_bridge.h");

    // Persist DLL path so Rust can find it at runtime.
    let env_path = out_path.join("exr_cpp_bridge_dll_path.txt");
    std::fs::write(&env_path, dll_path.to_string_lossy().as_bytes())
        .expect("write exr_cpp_bridge_dll_path.txt");
    println!(
        "cargo:rustc-env=EXR_CPP_BRIDGE_DLL_BUILD_PATH={}",
        dll_path.display()
    );
}

/// Locate link.exe next to cl.exe, or fall back to LIB env dirs.
///
/// MSVC's bin layout puts cl.exe and link.exe in the same directory
/// (e.g. `VC/Tools/MSVC/<ver>/bin/HostX64/x64/`).
fn find_link_exe() -> std::path::PathBuf {
    // First try: cl.exe's parent (cc::Tool knows it).
    let cl_candidates = [
        "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC",
        "C:/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC",
        "C:/Program Files (x86)/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC",
        "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC",
        "C:/Program Files (x86)/Microsoft Visual Studio/2022/Enterprise/VC/Tools/MSVC",
        "C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Tools/MSVC",
    ];
    for base in cl_candidates {
        if let Ok(entries) = std::fs::read_dir(base) {
            for v in entries.flatten() {
                let link = v.path().join("bin").join("HostX64").join("x64").join("link.exe");
                if link.exists() {
                    return link;
                }
            }
        }
    }
    // Fallback: search PATH.
    if let Some(p) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&p) {
            let candidate = dir.join("link.exe");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    std::path::PathBuf::from("link.exe")
}
