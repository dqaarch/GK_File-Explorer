// Debug script to compare Python vs Rust EXR decoding
// Run with: RUST_EXR_DEBUG_PIXELS=1 cargo run --bin debug_exr

use std::env;
use std::path::Path;
use std::fs;

fn main() {
    let test_file = r#"C:\Users\Mabu02\Downloads\Test File\Rnd__ALi_0015.exr"#;
    
    println!("[DEBUG] Testing EXR file: {}", test_file);
    println!("[DEBUG] File exists: {}", Path::new(test_file).exists());
    
    // Set debug flag
    env::set_var("RUST_EXR_DEBUG_PIXELS", "1");
    
    // Call the extract function
    let path = Path::new(test_file);
    
    // Just read and print some basic info
    println!("[DEBUG] Attempting to decode...");
    
    // For now, let's read raw bytes to check file structure
    match fs::read(test_file) {
        Ok(data) => {
            println!("[DEBUG] File size: {} bytes", data.len());
            
            // Check EXR magic number (0x01312F6F = 0x762F3101 in little endian)
            if data.len() >= 4 {
                let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
                println!("[DEBUG] EXR magic: 0x{:08X} (expected 0x01312F6F)", magic);
            }
            
            // Print first 64 bytes in hex
            println!("[DEBUG] First 64 bytes:");
            for i in 0..64.min(data.len()) {
                print!("{:02X} ", data[i]);
                if (i + 1) % 16 == 0 { println!(); }
            }
            println!();
        }
        Err(e) => {
            println!("[DEBUG] Error reading file: {}", e);
        }
    }
}
