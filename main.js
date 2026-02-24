import * as THREE from 'three';
import { SparkRenderer, SparkXr, SparkControls } from '@sparkjsdev/spark';
import { loadSplat } from './SplatLoader.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js'; // Import VRButton from three.js

let scene, camera, renderer, spark, controls, localFrame;
let xr = null;
let currentMesh = null;
let currentFileUrl = null;
let currentExtension = null;
let currentFileName = null;
let savedOrbitDistance = 3.0;

// FPS tracking variables
let lastFpsTime = performance.now();
let framesThisSecond = 0;
let fpsCounterEl = null;

// VR Scaling variables
let xrGripCount = 0;
let xrScaleActive = false;
let xrInitialDist = 0;
let xrInitialScale = 1;
let controller0, controller1;

async function init() {
    // 1. Core Architecture (Three.js Integration)
    scene = new THREE.Scene();
    localFrame = new THREE.Group();
    scene.add(localFrame);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
    camera.position.set(0, 0, 3); // Centered Y, offset Z by 3 for orbit
    localFrame.add(camera);

    renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true; // Enable XR
    document.body.appendChild(renderer.domElement);

    // VR Controllers Setup
    controller0 = renderer.xr.getController(0);
    controller1 = renderer.xr.getController(1);

    function onSqueezeStart() {
        xrGripCount++;
        if (xrGripCount === 2 && currentMesh) {
            xrScaleActive = true;
            xrInitialDist = controller0.position.distanceTo(controller1.position);
            xrInitialScale = currentMesh.scale.x;
            if (controls && controls.fpsMovement) controls.fpsMovement.enable = false;
        }
    }

    function onSqueezeEnd() {
        xrGripCount = Math.max(0, xrGripCount - 1);
        if (xrScaleActive) {
            xrScaleActive = false;
            if (controls && controls.fpsMovement) controls.fpsMovement.enable = true;
        }
    }

    controller0.addEventListener('squeezestart', onSqueezeStart);
    controller0.addEventListener('squeezeend', onSqueezeEnd);
    controller1.addEventListener('squeezestart', onSqueezeStart);
    controller1.addEventListener('squeezeend', onSqueezeEnd);

    scene.add(controller0);
    scene.add(controller1);

    spark = new SparkRenderer({
        renderer,
        lodSplatScale: 1.0, // Default LOD budget
    });
    scene.add(spark);

    // 3. WebXR Integration
    xr = new SparkXr({
        renderer,
        controllers: {
            moveHeading: true, // Move relative to where the headset is physical looking
            getMove: (gamepads) => {
                if (gamepads.leftIsHand) return new THREE.Vector3();

                const x = gamepads.left?.axes[2] ?? 0;
                const z = gamepads.left?.axes[3] ?? 0;
                let y = 0;

                // Use Right Controller A (4) and B (5) buttons for Y-axis flight
                if (gamepads.right?.buttons[4]?.pressed) y -= 1; // A -> Down
                if (gamepads.right?.buttons[5]?.pressed) y += 1; // B -> Up

                return new THREE.Vector3(x, y, z);
            }
        }
    });

    // 4. Camera Controls
    controls = new SparkControls({
        renderer,
        canvas: renderer.domElement,
    });

    // Disable SparkControls scroll zoom to let us control the Orbit Offset via scroll
    if (controls.pointerControls) {
        controls.pointerControls.scrollSpeed = 0;
    }

    // Custom Keybindings for Q/E (Down/Up) and R/F (Tilt/Pitch)
    if (controls.fpsMovement) {
        // Map E to Move Up, Q to Move Down
        controls.fpsMovement.keycodeMoveMapping.KeyE = new THREE.Vector3(0, 1, 0); // Move Up
        controls.fpsMovement.keycodeMoveMapping.KeyQ = new THREE.Vector3(0, -1, 0); // Move Down

        // Remove default rotation mappings for Q/E (Roll)
        delete controls.fpsMovement.keycodeRotateMapping.KeyQ;
        delete controls.fpsMovement.keycodeRotateMapping.KeyE;

        // Map R/F to roll (rotation around Z-axis -> rotate.z in SparkControls maps to eulers.z)
        controls.fpsMovement.keycodeRotateMapping.KeyR = new THREE.Vector3(0, 0, 1);  // Tilt Left (Roll)
        controls.fpsMovement.keycodeRotateMapping.KeyF = new THREE.Vector3(0, 0, -1); // Tilt Right (Roll)

        // Remove default movement mappings for R/F (Up/Down)
        delete controls.fpsMovement.keycodeMoveMapping.KeyR;
        delete controls.fpsMovement.keycodeMoveMapping.KeyF;
    }

    function loadSplatFromUrl(generateLod) {
        if (!currentFileUrl) return;

        document.getElementById('status').innerText = `Status: Loading ${currentFileName}...`;

        // Preserve transform if replacing mesh
        let oldScale = 1.0;
        let oldRotZ = document.getElementById('flip-mesh-cb').checked ? Math.PI : 0;
        let oldLodScale = parseFloat(document.getElementById('mesh-lod-slider').value);

        if (currentMesh) {
            oldScale = currentMesh.scale.x;
            scene.remove(currentMesh);
            currentMesh.dispose();
        }

        currentMesh = loadSplat(scene, currentFileUrl, currentFileName.endsWith('.rad'), currentExtension, currentFileName, generateLod);

        currentMesh.initialized.then(() => {
            document.getElementById('status').innerText = `Status: Loaded ${currentFileName}`;
            currentMesh.scale.set(oldScale, oldScale, oldScale);
            currentMesh.rotation.z = oldRotZ;
            currentMesh.lodScale = oldLodScale;
        }).catch((err) => {
            console.error(err);
            document.getElementById('status').innerText = `Status: Error loading ${currentFileName}`;
        });
    }

    // UI Hooks
    const fileInput = document.getElementById('file-input');
    document.getElementById('load-btn').onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            if (currentFileUrl) URL.revokeObjectURL(currentFileUrl);
            currentFileUrl = URL.createObjectURL(file);
            currentExtension = file.name.split('.').pop();
            currentFileName = file.name;
            const generateLod = document.getElementById('lod-mesh-cb').checked;
            loadSplatFromUrl(generateLod);
        }
    };

    // Drag and Drop Support
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            const extension = file.name.split('.').pop().toLowerCase();
            const validExtensions = ['spz', 'rad', 'ply', 'sog'];

            if (validExtensions.includes(extension)) {
                if (currentFileUrl) URL.revokeObjectURL(currentFileUrl);
                currentFileUrl = URL.createObjectURL(file);
                currentExtension = extension;
                currentFileName = file.name;
                const generateLod = document.getElementById('lod-mesh-cb').checked;
                loadSplatFromUrl(generateLod);
            } else {
                alert("Unsupported file type. Please drop a .spz, .rad, .ply, or .sog file.");
            }
        }
    });

    // UI Event Listeners for Scale, Flip, Orbit, LOD, FPS Mode, and UI minimize
    const toggleBtn = document.getElementById('toggle-ui-btn');
    const contentWrapper = document.getElementById('ui-content-wrapper');
    toggleBtn.addEventListener('click', () => {
        if (contentWrapper.style.display === 'none') {
            contentWrapper.style.display = 'block';
            toggleBtn.innerText = '➖ Minimize UI';
        } else {
            contentWrapper.style.display = 'none';
            toggleBtn.innerText = '➕ Show UI';
        }
    });

    document.getElementById('lod-mesh-cb').addEventListener('change', (e) => {
        // If they click generate LODs on an already loaded model, rebuild it instantly from the blob URL
        if (currentFileUrl) {
            loadSplatFromUrl(e.target.checked);
        }
    });

    document.getElementById('fps-mode-cb').addEventListener('change', (e) => {
        const fpsEnabled = e.target.checked;
        const slider = document.getElementById('orbit-slider');

        if (fpsEnabled) {
            savedOrbitDistance = camera.position.z;
            setOrbitDistance(0.0);
            slider.disabled = true;
        } else {
            setOrbitDistance(savedOrbitDistance);
            slider.disabled = false;
        }
    });

    document.getElementById('global-lod-slider').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        document.getElementById('global-lod-value').innerText = val.toFixed(1);
        if (spark) {
            spark.lodSplatScale = val;
        }
    });

    document.getElementById('mesh-lod-slider').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        document.getElementById('mesh-lod-value').innerText = val.toFixed(1);
        if (currentMesh) {
            currentMesh.lodScale = val;
        }
    });

    document.getElementById('scale-slider').addEventListener('input', (e) => {
        const scale = parseFloat(e.target.value);
        document.getElementById('scale-value').innerText = scale.toFixed(1);
        if (currentMesh) {
            currentMesh.scale.set(scale, scale, scale);
        }
    });

    document.getElementById('flip-mesh-cb').addEventListener('change', (e) => {
        if (currentMesh) {
            currentMesh.rotation.z = e.target.checked ? Math.PI : 0;
        }
    });

    function setOrbitDistance(newOffset) {
        camera.position.z = newOffset;
        document.getElementById('orbit-slider').value = newOffset;
        document.getElementById('orbit-value').innerText = newOffset.toFixed(1);
    }

    document.getElementById('orbit-slider').addEventListener('input', (e) => {
        setOrbitDistance(parseFloat(e.target.value));
    });

    // Use mouse wheel to dynamically adjust orbit distance based on current offset
    window.addEventListener('wheel', (e) => {
        if (document.getElementById('fps-mode-cb').checked) {
            // In First Person mode, scrolling physically walks the camera forward/backward along its view ray
            const dir = new THREE.Vector3();
            camera.getWorldDirection(dir);
            // e.deltaY > 0 means scroll down (zoom out / move backward)
            dir.multiplyScalar(e.deltaY * -0.005);
            localFrame.position.add(dir);
        } else {
            let newOffset = camera.position.z + e.deltaY * 0.005;
            newOffset = Math.max(0, Math.min(40, newOffset)); // Allow zooming further out
            setOrbitDistance(newOffset);
        }
    }, { passive: true });

    window.addEventListener('resize', onWindowResize, false);

    document.getElementById('status').innerText = 'Status: Ready';

    // Check for ?splat= or ?file= parameter auto-loading (Vite reserves ?url=)
    const urlParams = new URLSearchParams(window.location.search);

    // Process optional UI configuration parameters
    if (urlParams.has('lodgen')) {
        document.getElementById('lod-mesh-cb').checked = urlParams.get('lodgen').toLowerCase() === 'true';
    }
    if (urlParams.has('flip')) {
        document.getElementById('flip-mesh-cb').checked = urlParams.get('flip').toLowerCase() === 'true';
    }
    if (urlParams.has('loddetail')) {
        const val = parseFloat(urlParams.get('loddetail'));
        if (!isNaN(val)) {
            document.getElementById('mesh-lod-slider').value = val;
            document.getElementById('mesh-lod-value').innerText = val.toFixed(1);
        }
    }
    if (urlParams.has('lodquality')) {
        const val = parseFloat(urlParams.get('lodquality'));
        if (!isNaN(val)) {
            document.getElementById('global-lod-slider').value = val;
            document.getElementById('global-lod-value').innerText = val.toFixed(1);
            if (spark) spark.lodSplatScale = val;
        }
    }

    const passedUrl = urlParams.get('splat') || urlParams.get('file') || urlParams.get('load');
    if (passedUrl) {
        currentFileUrl = passedUrl;

        // Clean the URL of any trailing query parameters for cleaner extension and filename parsing
        const cleanUrl = passedUrl.split('?')[0].split('&')[0];

        currentExtension = cleanUrl.split('.').pop().toLowerCase();
        currentFileName = cleanUrl.substring(cleanUrl.lastIndexOf('/') + 1) || "URL_Mesh";

        const generateLod = document.getElementById('lod-mesh-cb').checked;
        loadSplatFromUrl(generateLod);
    }

    fpsCounterEl = document.getElementById('fps-counter');

    animate();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    renderer.setAnimationLoop((time, frame) => {
        // Calculate FPS
        framesThisSecond++;
        if (time >= lastFpsTime + 1000) {
            fpsCounterEl.innerText = `FPS: ${Math.round((framesThisSecond * 1000) / (time - lastFpsTime))}`;
            framesThisSecond = 0;
            lastFpsTime = time;
        }

        // VR Scaling Logic
        let xrIsPresenting = renderer.xr.isPresenting;

        if (xrIsPresenting && currentMesh && xrScaleActive) {
            const currentDist = controller0.position.distanceTo(controller1.position);
            const scaleFactor = currentDist / xrInitialDist;
            const newScale = Math.max(0.1, Math.min(10, xrInitialScale * scaleFactor));

            currentMesh.scale.set(newScale, newScale, newScale);

            // Sync UI slider
            document.getElementById('scale-slider').value = newScale;
            document.getElementById('scale-value').innerText = newScale.toFixed(1);
        }

        if (controls && controls.fpsMovement) {
            controls.fpsMovement.enable = !xrIsPresenting || (!xrScaleActive && !renderer.xr.isPresenting); // native handling for desktop
        }

        if (controls && localFrame && !xrScaleActive && !xrIsPresenting) {
            controls.update(localFrame, camera);
        }
        if (xr) {
            xr.updateControllers(camera);
        }

        // Update Splat Count
        if (spark && document.getElementById('splat-count-value')) {
            const renderedCount = spark.activeSplats || 0;
            const totalCount = currentMesh ? (currentMesh.numSplats || 0) : 0;

            let displayStr = renderedCount.toLocaleString();
            if (totalCount > 0) {
                displayStr += ` / ${totalCount.toLocaleString()}`;
            }

            document.getElementById('splat-count-value').innerText = displayStr;
        }

        // SparkViewpoint and sorting are handled internally by SparkRenderer
        renderer.render(scene, camera);
    });
}

function detectMobile() {
    const isMobile = (navigator.maxTouchPoints > 0) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
        console.log("Mobile device detected. Optimizing defaults...");

        // Default to lower LOD quality on mobile for performance
        if (spark) {
            spark.lodSplatScale = 0.5;
            document.getElementById('global-lod-slider').value = 0.5;
            document.getElementById('global-lod-value').innerText = "0.5";
        }

        // Invert orbit for mobile (Touch users often prefer "pulling" the world)
        if (controls && controls.pointerControls) {
            // SparkControls defaults reverseRotate to true for mobile.
            // Setting it to false provides the "pulling the world" inversion the user wants.
            controls.pointerControls.reverseRotate = false;
        }
    }
}

init().then(() => {
    detectMobile();
});
