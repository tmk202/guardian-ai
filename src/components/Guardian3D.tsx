"use client";
// 3D brand accent: a slowly rotating wireframe "guardian orb" (icosahedron +
// orbiting data points) in PayPal blue, rendered with three.js.
// Discipline (same pattern as our production sites): dynamic import so the
// library stays out of the first paint, DPR capped at 1.5, animation pauses
// when the tab is hidden, prefers-reduced-motion gets a single static frame,
// and any WebGL failure falls back to a static SVG shield.
import { useEffect, useRef, useState } from "react";

export default function Guardian3D() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let raf = 0;
    let renderer: any = null;
    let disposed = false;

    (async () => {
      try {
        const THREE = await import("three");
        const host = hostRef.current;
        if (!host || disposed) return;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.setSize(host.clientWidth, host.clientHeight);
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, 0.1, 100);
        camera.position.set(0, 0, 4.4);

        const group = new THREE.Group();
        scene.add(group);

        const geo = new THREE.IcosahedronGeometry(1.25, 1);
        const wire = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: 0x0070e0, transparent: true, opacity: 0.9 })
        );
        group.add(wire);
        const core = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.78, 1),
          new THREE.MeshBasicMaterial({ color: 0x003087, transparent: true, opacity: 0.1 })
        );
        group.add(core);

        // orbiting data points
        const n = 140;
        const pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const r = 1.75 + Math.random() * 0.35;
          const th = Math.random() * Math.PI * 2;
          const ph = Math.acos(2 * Math.random() - 1);
          pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
          pos[i * 3 + 1] = r * Math.cos(ph) * 0.62;
          pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        }
        const pgeo = new THREE.BufferGeometry();
        pgeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const points = new THREE.Points(
          pgeo,
          new THREE.PointsMaterial({ color: 0x009cde, size: 0.045, transparent: true, opacity: 0.85 })
        );
        group.add(points);

        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const renderFrame = (t: number) => {
          group.rotation.y = t * 0.00022;
          group.rotation.x = Math.sin(t * 0.0004) * 0.18;
          points.rotation.y = -t * 0.00012;
          renderer.render(scene, camera);
        };
        if (reduced) {
          renderFrame(1200);
        } else {
          const loop = (t: number) => {
            if (disposed) return;
            if (!document.hidden) renderFrame(t);
            raf = requestAnimationFrame(loop);
          };
          raf = requestAnimationFrame(loop);
        }

        const onResize = () => {
          if (!host) return;
          camera.aspect = host.clientWidth / host.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(host.clientWidth, host.clientHeight);
          if (reduced) renderFrame(1200);
        };
        window.addEventListener("resize", onResize);
        // cleanup on unmount
        (host as any).__g3dCleanup = () => window.removeEventListener("resize", onResize);
      } catch {
        setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      const host = hostRef.current as any;
      if (host?.__g3dCleanup) host.__g3dCleanup();
      if (renderer) {
        renderer.dispose();
        renderer.domElement?.remove();
      }
    };
  }, []);

  if (failed) {
    return (
      <div className="hero3d" aria-hidden="true">
        <div className="fallback">
          <svg width="72" height="72" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3l7 2.6v5.2c0 4.6-3 8.4-7 10.2-4-1.8-7-5.6-7-10.2V5.6L12 3z" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 12l2 2 4-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    );
  }
  return <div className="hero3d" ref={hostRef} aria-hidden="true" />;
}
