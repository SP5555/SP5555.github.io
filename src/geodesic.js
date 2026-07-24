import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

// Builds a geodesic sphere's topology from a subdivided icosahedron: unique
// vertex positions plus a deduplicated edge list (pairs of vertex indices).
//
// `detail` follows THREE.IcosahedronGeometry's own convention: 0 is the
// classic 12-vertex/30-edge icosahedron, and each step up subdivides every
// triangular face into 4 smaller ones (pushed out to the sphere), so higher
// detail approximates a sphere more closely.
//
// three.js's IcosahedronGeometry emits a *non-indexed* buffer — adjacent
// triangles each carry their own duplicate copies of shared-seam vertices —
// so mergeVertices() welds those duplicates back into a real indexed mesh
// before we read off vertices/edges.
export function buildGeodesicTopology(radius, detail) {
  const seed = new THREE.IcosahedronGeometry(radius, detail);
  // We only ever read .position — drop uv/normal first so seam vertices that
  // sit at the exact same 3D position (but differ only in UV, e.g. the u=0
  // vs u=1 wrap-around) actually get welded by mergeVertices instead of
  // surviving as duplicate, coincident vertices.
  seed.deleteAttribute("uv");
  seed.deleteAttribute("normal");
  const merged = mergeVertices(seed);

  const posAttr = merged.attributes.position;
  const vertices = [];
  for (let i = 0; i < posAttr.count; i++) {
    vertices.push(
      new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i))
    );
  }

  const index = merged.index.array;
  const seenEdges = new Set();
  const edges = [];
  for (let i = 0; i < index.length; i += 3) {
    const tri = [index[i], index[i + 1], index[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push([a, b]);
      }
    }
  }

  seed.dispose();
  merged.dispose();

  return { vertices, edges };
}
