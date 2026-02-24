# SimpleSparkViewer

A fast, lightweight, and incredibly responsive Web-based 3D Gaussian Splat viewer built on top of the modern `SparkJS 2` framework and `Three.js`. Designed for seamless accessibility, this viewer provides an out-of-the-box solution for rendering massive splat environments natively in your browser, complete with full WebXR (VR) support.

## Key Features
*   **Universal Format Support**: Drag-and-drop support for `.spz`, `.rad`, `.ply` and PlayCanvas compressed `.sog` splat formats directly into the browser.
*   **Dynamic LOD Streaming**: Generates hierarchical Levels of Detail (LODs) on-the-fly for massive environments utilizing Web Workers and memory `Blob URLs` for instant hot-swapping without re-importing.
*   **Native WebXR Integration**: Full VR support with head-relative locomotion. Click "Enter VR" to fly through scenes using your controllers. (Left thumbstick to move, Right thumbstick to turn, A/B buttons for vertical altitude).
*   **Real-time UI Overlays**: Tweak your Global LOD Quality, Mesh Detail bounds, and Model Scale in real-time. Includes a built-in FPS monitor for performance tuning.
*   **First-Person Flycam**: A togglable "First Person Mode" that converts the default Three.js Orbit Controls into a classic WASD flycam. Use the mouse scroll wheel to natively push back and forward along your view ray.
*   **Instant Auto-Loading**: Pre-configure and instantly boot the viewer into any environment via URL queries.
    *   Example: `https://<your-username>.github.io/SimpleSparkViewer/?splat=https://domain.com/splat.spz&lodgen=true&flip=true`
    *   Parameters: ?splat=url &lodgen=true|false &flip=true|false &loddetail=<number>, and &lodquality=<number>

## Local Development
To run this application locally on your machine:
1. Clone the repository.
2. Run `npm install` to grab the necessary dependencies.
3. Run `npm run dev` to start a local Vite server.

## Deployment
This project is configured out-of-the-box to deploy to **GitHub Pages**. Simply push your changes to your `main` branch, and GitHub Actions will automatically handle the build and deployment process. Ensure that GitHub Pages is enabled in your repository's **Settings > Pages** and set the source to `GitHub Actions`.
