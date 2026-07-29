// STL Reader Module - Read STL files and return mesh data for 3D rendering

use std::fs::OpenOptions;
use std::path::Path;

#[derive(Debug, serde::Serialize)]
pub struct StlDecodeResult {
    pub success: bool,
    pub triangles_count: usize,
    pub vertices_count: usize,
    // Flattened vertex data: [x1,y1,z1, x2,y2,z2, ..., xn,yn,zn]
    pub vertices: Vec<f32>,
    // Flattened normal data: [nx1,ny1,nz1, nx2,ny2,nz2, ..., nxn,nyn,nzn]
    pub normals: Vec<f32>,
    pub error: Option<String>,
}

pub fn decode_stl(path: &Path) -> StlDecodeResult {
    println!("[STL] decode_stl: Starting...");

    let mut file = match OpenOptions::new().read(true).open(path) {
        Ok(f) => f,
        Err(e) => {
            println!("[STL] Failed to open file: {}", e);
            return StlDecodeResult {
                success: false,
                triangles_count: 0,
                vertices_count: 0,
                vertices: vec![],
                normals: vec![],
                error: Some(format!("Failed to open file: {}", e)),
            };
        }
    };

    // Read the STL file
    let stl = match stl_io::read_stl(&mut file) {
        Ok(s) => s,
        Err(e) => {
            println!("[STL] Failed to parse STL: {}", e);
            return StlDecodeResult {
                success: false,
                triangles_count: 0,
                vertices_count: 0,
                vertices: vec![],
                normals: vec![],
                error: Some(format!("Failed to parse STL: {}", e)),
            };
        }
    };

    let triangles_count = stl.faces.len();
    let vertices_count = triangles_count * 3;

    let mut vertices = Vec::with_capacity(vertices_count * 3);
    let mut normals = Vec::with_capacity(triangles_count * 3);

    for face in &stl.faces {
        let v0 = stl.vertices[face.vertices[0]];
        let v1 = stl.vertices[face.vertices[1]];
        let v2 = stl.vertices[face.vertices[2]];

        // stl_io 0.11 provides a per-face normal on IndexedTriangle.
        let n = face.normal;
        let nlen = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        let (nx, ny, nz) = if nlen > 0.0 {
            (n[0] / nlen, n[1] / nlen, n[2] / nlen)
        } else {
            // Fallback: derive normal from vertex order via cross product.
            let ax = v1[0] - v0[0];
            let ay = v1[1] - v0[1];
            let az = v1[2] - v0[2];
            let bx = v2[0] - v0[0];
            let by = v2[1] - v0[1];
            let bz = v2[2] - v0[2];
            let cx = ay * bz - az * by;
            let cy = az * bx - ax * bz;
            let cz = ax * by - ay * bx;
            let cl = (cx * cx + cy * cy + cz * cz).sqrt();
            if cl > 0.0 { (cx / cl, cy / cl, cz / cl) } else { (0.0, 0.0, 1.0) }
        };

        normals.push(nx);
        normals.push(ny);
        normals.push(nz);

        for v in [v0, v1, v2] {
            vertices.push(v[0]);
            vertices.push(v[1]);
            vertices.push(v[2]);
        }
    }

    println!("[STL] decode_stl: {} triangles, {} vertices", triangles_count, vertices_count);

    StlDecodeResult {
        success: true,
        triangles_count,
        vertices_count,
        vertices,
        normals,
        error: None,
    }
}
