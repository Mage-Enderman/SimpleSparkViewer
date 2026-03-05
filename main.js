import * as THREE from 'three';
import { SparkRenderer, SparkXr, SparkControls } from '@sparkjsdev/spark';
import { loadSplat } from './SplatLoader.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js'; // Import VRButton from three.js
import { MultiplayerManager } from './MultiplayerManager.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

let scene, camera, renderer, spark, controls, localFrame;
let multiplayer;
let xr = null;
let currentMesh = null;
let currentFileUrl = null;
let currentExtension = null;
let currentFileName = null;
let savedOrbitDistance = 3.0;
let localLeftHand, localRightHand;


// Global model data for sharing
let currentModelBlob = null;
let expectedModelSize = 0;
let currentBytesReceived = 0;

// FPS tracking variables
let lastFpsTime = performance.now();
let framesThisSecond = 0;
let fpsCounterEl = null;

// --- P2P Global Fetch Interceptor ---
if (!window._originalFetch) {
    window._originalFetch = window.fetch;
    window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const isP2P = url.includes('://p2p/') || url.startsWith('p2p://');

        let rangeHeader = null;
        if (init?.headers) {
            if (init.headers instanceof Headers) {
                rangeHeader = init.headers.get('Range') || init.headers.get('range');
            } else {
                rangeHeader = init.headers.Range || init.headers.range;
            }
        } else if (input instanceof Request) {
            rangeHeader = input.headers.get('Range') || input.headers.get('range');
        }

        if (isP2P && rangeHeader) {
            const match = rangeHeader.match(/bytes=(\d+)-(\d+)/);
            if (match) {
                const start = parseInt(match[1]);
                const end = parseInt(match[2]); // inclusive

                return new Promise((resolve) => {
                    let timeout = null;
                    const onData = (e) => {
                        if (e.detail.range.start === start && e.detail.range.end === end) {
                            clearTimeout(timeout);
                            currentBytesReceived += e.detail.data.byteLength;

                            // Update progress
                            if (expectedModelSize > 0) {
                                const progress = Math.min(100, (currentBytesReceived / expectedModelSize) * 100);
                                const progressContainer = document.getElementById('p2p-progress-container');
                                if (progressContainer) progressContainer.style.display = 'block';
                                const progressBar = document.getElementById('p2p-progress-bar');
                                if (progressBar) progressBar.style.width = `${progress}%`;
                            }

                            console.log(`P2P Fetch: Received range ${start}-${end}`);
                            window.removeEventListener('peer-model-data', onData);
                            resolve(new Response(e.detail.data));
                        }
                    };
                    window.addEventListener('peer-model-data', onData);

                    const hostPeerId = multiplayer && multiplayer.roomId ? multiplayer.roomId : null;
                    const conn = (hostPeerId && multiplayer) ? multiplayer.connections.get(hostPeerId) : null;
                    if (conn) {
                        conn.send({
                            type: 'MODEL_DATA_REQ',
                            payload: { start, end }
                        });
                    } else {
                        window.removeEventListener('peer-model-data', onData);
                        resolve(window._originalFetch(input, init));
                    }

                    timeout = setTimeout(() => {
                        window.removeEventListener('peer-model-data', onData);
                        resolve(window._originalFetch(input, init));
                    }, 15000);
                });
            }
        }
        return window._originalFetch(input, init);
    };
}


// VR Scaling variables
let xrGripCount = 0;
let xrScaleActive = false;
let xrInitialDist = 0;
let xrInitialScale = 1;
let controller0, controller1;
let lastXPressed = false;
let lastYPressed = false;


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

    // Add Scene Lighting for avatars
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

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

    // Add visual meshes to local controllers (so the user can see their own hands)
    const handGeo = new THREE.BoxGeometry(0.05, 0.02, 0.1);
    const handMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    localLeftHand = new THREE.Mesh(handGeo, handMat);
    localRightHand = new THREE.Mesh(handGeo, handMat);
    controller0.add(localLeftHand);
    controller1.add(localRightHand);

    // Initially hidden
    localLeftHand.visible = false;
    localRightHand.visible = false;

    // Add controllers to localFrame so they move with the player space
    localFrame.add(controller0);
    localFrame.add(controller1);

    spark = new SparkRenderer({
        renderer,
        lodSplatScale: 1.0, // Default LOD budget
    });
    scene.add(spark);

    // Multiplayer Initialization
    const roomFromHash = window.location.hash.substring(1);
    multiplayer = new MultiplayerManager(
        scene,
        onPeerModelAnnounced,
        onPeerRangeRequest
    );

    const mpToggleBtn = document.getElementById('multiplayer-toggle-btn');
    const mpPanel = document.getElementById('multiplayer-panel');
    const mpSetup = document.getElementById('mp-setup-section');
    const mpActive = document.getElementById('mp-active-section');
    const mpJoinIdInput = document.getElementById('mp-join-id');
    const mpStatus = document.getElementById('mp-status');

    mpToggleBtn.onclick = () => {
        mpPanel.style.display = mpPanel.style.display === 'none' ? 'block' : 'none';
        mpToggleBtn.style.background = mpPanel.style.display === 'none' ? 'rgba(100,100,255,0.4)' : 'rgba(255,100,100,0.4)';
    };

    if (roomFromHash) {
        mpJoinIdInput.value = roomFromHash;
        setTimeout(() => {
            mpPanel.style.display = 'block';
            mpToggleBtn.style.background = 'rgba(255,100,100,0.4)';
            mpStatus.innerText = "Connecting (Smart)...";
            multiplayer.smartInit(roomFromHash).then(onConnected).catch(err => {
                mpStatus.innerText = "Connection Error";
            });
        }, 500);
    }

    const onConnected = () => {
        mpSetup.style.display = 'none';
        mpActive.style.display = 'block';
        mpStatus.innerText = "Connected";
        document.getElementById('mp-role').innerText = multiplayer.isHost ? "Host" : "Client";
        document.getElementById('room-id').innerText = multiplayer.roomId;
        document.getElementById('player-count').innerText = "1";
    };

    document.getElementById('mp-host-btn').onclick = () => {
        mpStatus.innerText = "Hosting...";
        multiplayer.host().then(onConnected).catch(err => {
            mpStatus.innerText = "Host Error";
        });
    };

    document.getElementById('mp-join-btn').onclick = () => {
        const joinId = mpJoinIdInput.value.trim();
        if (!joinId) return;
        mpStatus.innerText = "Joining...";
        multiplayer.join(joinId).then(onConnected).catch(err => {
            mpStatus.innerText = "Join Error";
        });
    };

    // GLTF Head loader for remote avatars
    const gltfLoader = new GLTFLoader();
    gltfLoader.load('VRHeadset.glb', (gltf) => {
        const headMesh = gltf.scene;
        headMesh.scale.set(0.05, 0.05, 0.05); // Half size (from 0.1)

        // Force solid grey material
        const greyMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
        headMesh.traverse((node) => {
            if (node.isMesh) node.material = greyMat;
        });

        multiplayer.remoteHeadModel = headMesh;
    });

    document.getElementById('copy-room-btn').onclick = () => {
        const url = new URL(window.location.href);
        url.hash = multiplayer.roomId;
        navigator.clipboard.writeText(url.toString());
        const btn = document.getElementById('copy-room-btn');
        const oldText = btn.innerText;
        btn.innerText = "Copied Room Link!";
        setTimeout(() => btn.innerText = oldText, 2000);
    };

    multiplayer.broadcastModelInfo = (specificConn = null) => {
        if (!currentMesh || !currentFileName) return;

        // Estimate size if blob is missing
        let size = 0;
        if (currentModelBlob) {
            size = currentModelBlob.size;
        } else if (currentMesh.packedSplats && currentMesh.packedSplats.packedArray) {
            size = currentMesh.packedSplats.packedArray.byteLength;
        } else if (currentMesh.extSplats && currentMesh.extSplats.packedArray) {
            size = currentMesh.extSplats.packedArray.byteLength;
        } else if (currentMesh.splats && typeof currentMesh.splats.getNumSplats === 'function') {
            size = currentMesh.splats.getNumSplats() * 32; // Estimate
        }

        const isExternalUrl = currentFileUrl && (currentFileUrl.startsWith('http') && !currentFileUrl.includes('://p2p/'));

        const msg = {
            type: 'MODEL_ANNOUNCE',
            payload: {
                name: currentFileName,
                extension: currentExtension,
                size: size,
                isRad: currentFileName.toLowerCase().endsWith('.rad'),
                url: isExternalUrl ? currentFileUrl : null
            }
        };
        if (specificConn) {
            specificConn.send(msg);
        } else {
            multiplayer.broadcast(msg);
        }
    };

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


    async function loadSplatFromUrl(generateLod, blob = null) {
        // Robust peer check: we are in a room, not host
        const isPeerModel = !blob && !!multiplayer.roomId && !multiplayer.isHost && (currentFileUrl && currentFileUrl.includes('://p2p/'));
        if (!currentFileUrl && !blob && !isPeerModel) return;

        // Reset progress
        currentBytesReceived = 0;
        const progressBar = document.getElementById('p2p-progress-bar');
        if (progressBar) progressBar.style.width = '0%';
        const progressContainer = document.getElementById('p2p-progress-container');
        if (progressContainer) progressContainer.style.display = 'none';

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

        const isRad = currentFileName.toLowerCase().endsWith('.rad') || (currentFileUrl && currentFileUrl.toLowerCase().includes('.rad'));

        let urlToLoad = currentFileUrl;
        if (blob) {
            urlToLoad = URL.createObjectURL(blob);
        }

        // For non-RAD models, fetch the whole thing via P2P chunks first to show progress
        if (!isRad && isPeerModel && expectedModelSize > 0) {
            document.getElementById('status').innerText = `Status: Requesting model from host...`;
            document.getElementById('p2p-progress-container').style.display = 'block';

            const chunks = [];
            let offset = 0;
            const chunkSize = 131072; // 128kb chunks

            while (offset < expectedModelSize) {
                const end = Math.min(offset + chunkSize, expectedModelSize);
                const chunk = await requestP2PChunk(offset, end);
                if (chunk) {
                    chunks.push(chunk);
                    offset = end;
                } else {
                    console.error("P2P: Failed to get chunk, falling back");
                    break;
                }
            }

            if (offset >= expectedModelSize) {
                const fullBlob = new Blob(chunks);
                urlToLoad = URL.createObjectURL(fullBlob);
            }
        }

        function requestP2PChunk(start, end) {
            return new Promise((resolve) => {
                const onData = (e) => {
                    // For chunks, 'end' is exclusive (like slice length)
                    if (e.detail.range.start === start && e.detail.range.end === end) {
                        currentBytesReceived += e.detail.data.byteLength;
                        const progress = Math.min(100, (currentBytesReceived / expectedModelSize) * 100);
                        document.getElementById('p2p-progress-bar').style.width = `${progress}%`;

                        window.removeEventListener('peer-model-data', onData);
                        resolve(e.detail.data);
                    }
                };
                window.addEventListener('peer-model-data', onData);

                const hostPeerId = multiplayer.roomId;
                const conn = hostPeerId ? multiplayer.connections.get(hostPeerId) : null;
                if (conn) {
                    console.log(`P2P: Requesting chunk ${start}-${end} (Size: ${end - start})`);
                    conn.send({
                        type: 'MODEL_CHUNK_REQ',
                        payload: { start, end } // Exclusive end for chunks
                    });
                } else {
                    console.warn("P2P: No host connection for chunk request");
                    resolve(null);
                }

                setTimeout(() => {
                    window.removeEventListener('peer-model-data', onData);
                    resolve(null);
                }, 10000);
            });
        }

        currentMesh = loadSplat(scene, urlToLoad, isRad, currentExtension, currentFileName, generateLod);

        currentMesh.initialized.then(() => {
            document.getElementById('status').innerText = `Status: Loaded ${currentFileName}`;
            document.getElementById('p2p-progress-container').style.display = 'none';
            document.getElementById('p2p-progress-bar').style.width = '0%';
            currentBytesReceived = 0;

            currentMesh.scale.set(oldScale, oldScale, oldScale);
            currentMesh.rotation.z = oldRotZ;
            currentMesh.lodScale = oldLodScale;

            if (multiplayer.isHost) {
                multiplayer.broadcastModelInfo();
            }
        }).catch((err) => {
            window.fetch = originalFetch;
            document.getElementById('p2p-progress-container').style.display = 'none';
            console.error(err);
            document.getElementById('status').innerText = `Status: Error loading ${currentFileName}`;
        });
    }

    function onPeerModelAnnounced(peerId, info) {
        if (multiplayer.isHost) return; // Host ignores announcements

        // Check if we already have this model loaded or loading from URL parameter
        // This prevents the "infinite reload loop" when both have same URL
        if (currentFileName === info.name && currentMesh) {
            console.log("Announcement matches current local load. Skipping redundant reload.");
            return;
        }

        currentFileName = info.name;
        currentExtension = info.extension;
        expectedModelSize = info.size || 0;
        currentBytesReceived = 0;

        // Prefer direct URL if host provides a public one, otherwise use P2P proxy
        if (info.url) {
            console.log("Peer shared direct URL:", info.url);
            currentFileUrl = info.url;
            document.getElementById('status').innerText = `Status: Peer sharing ${info.name} (Direct URL)...`;
        } else {
            // Virtual P2P URL to trigger the interceptor
            currentFileUrl = "http://p2p/" + info.name;
            if (info.isRad) {
                document.getElementById('status').innerText = `Status: Peer sharing ${info.name} (P2P Paged)...`;
            } else {
                console.log("Remote model announced:", info.name);
                document.getElementById('status').innerText = `Status: Peer sharing ${info.name} (P2P)...`;
            }
        }

        // Auto-load the shared model
        loadSplatFromUrl(document.getElementById('lod-mesh-cb').checked);
    }

    async function onPeerRangeRequest(peerId, type, range) {
        let chunkData = null;

        // Determine slice points based on request type
        // MODEL_DATA_REQ (from fetch) uses inclusive end
        // MODEL_CHUNK_REQ (from loop) uses exclusive end
        const isInclusive = (type === 'MODEL_DATA_REQ');
        const start = range.start;
        const end = isInclusive ? range.end + 1 : range.end;

        if (currentModelBlob) {
            const slice = currentModelBlob.slice(start, end);
            chunkData = await slice.arrayBuffer();
        } else if (currentFileUrl && !currentFileUrl.includes('://p2p/')) {
            // Host fallback: Fetch from original URL
            try {
                const response = await window._originalFetch(currentFileUrl, {
                    headers: { 'Range': `bytes=${start}-${end - 1}` }
                });
                if (response.ok) chunkData = await response.arrayBuffer();
            } catch (e) {
                console.error("Host: Failed to proxy range request", e);
            }
        }

        if (chunkData) {
            const conn = multiplayer.connections.get(peerId);
            if (conn) {
                conn.send({
                    type: isInclusive ? 'MODEL_DATA_CHUNK' : 'MODEL_CHUNK',
                    payload: {
                        range: range, // Send back original range for matching
                        data: chunkData
                    }
                });
            }
        }
    }

    // UI Hooks
    const fileInput = document.getElementById('file-input');
    document.getElementById('load-btn').onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            if (currentFileUrl) URL.revokeObjectURL(currentFileUrl);
            currentFileUrl = URL.createObjectURL(file);
            currentModelBlob = file;
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
                currentModelBlob = file;
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
        setGlobalLod(parseFloat(e.target.value));
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

    // Reset Camera Functionality
    document.getElementById('reset-camera-btn').addEventListener('click', () => {
        // Reset local frame (which holds camera and controllers) position/rotation
        localFrame.position.set(0, 0, 0);
        localFrame.rotation.set(0, 0, 0);

        // Reset camera position back to default
        const isFps = document.getElementById('fps-mode-cb').checked;
        camera.position.set(0, 0, isFps ? 0 : savedOrbitDistance);
        camera.rotation.set(0, 0, 0);

        if (!isFps) {
            setOrbitDistance(savedOrbitDistance);
        }

        // Reset controls state if possible
        if (controls && controls.pointerControls) {
            controls.pointerControls.reset();
        }
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
        // We use a more robust way to get the path part of the URL
        let urlPath = passedUrl;
        try {
            urlPath = new URL(passedUrl).pathname;
        } catch (e) {
            urlPath = passedUrl.split('?')[0].split('#')[0];
        }

        currentExtension = urlPath.split('.').pop().toLowerCase();
        currentFileName = urlPath.substring(urlPath.lastIndexOf('/') + 1) || "URL_Mesh";

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
        const session = renderer.xr.getSession();

        // Update local hand visibility
        if (localLeftHand) localLeftHand.visible = xrIsPresenting;
        if (localRightHand) localRightHand.visible = xrIsPresenting;

        // Reset rotation and initial position once when entering VR
        if (xrIsPresenting && !renderer.xr.isPresentingLastFrame) {
            localFrame.rotation.set(0, 0, 0);
            // Often good to reset position as well when entering VR so they start centered
            localFrame.position.set(0, 0, 0);
        }
        renderer.xr.isPresentingLastFrame = xrIsPresenting;

        if (xrIsPresenting && session) {
            for (const source of session.inputSources) {
                if (source.handedness === 'left' && source.gamepad) {
                    const buttons = source.gamepad.buttons;
                    // X button is index 4, Y button is index 5
                    const xPressed = buttons[4]?.pressed || false;
                    const yPressed = buttons[5]?.pressed || false;

                    if (xPressed && !lastXPressed) {
                        setGlobalLod(spark.lodSplatScale - 0.1);
                    }
                    if (yPressed && !lastYPressed) {
                        setGlobalLod(spark.lodSplatScale + 0.1);
                    }
                    lastXPressed = xPressed;
                    lastYPressed = yPressed;
                }
            }
        }
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

        if (multiplayer && multiplayer.peer) {
            const currentScale = currentMesh ? currentMesh.scale.x : 1.0;
            multiplayer.currentModelScale = currentScale; // Make scale available for incoming data
            multiplayer.updateLocalState(camera, controller0, controller1, renderer.xr.isPresenting, currentScale);

            const count = multiplayer.connections.size + 1;
            const el = document.getElementById('player-count');
            if (el) el.innerText = count;
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

function setGlobalLod(val) {
    val = Math.max(0.1, Math.min(5.0, val));
    const slider = document.getElementById('global-lod-slider');
    const display = document.getElementById('global-lod-value');
    if (slider) slider.value = val;
    if (display) display.innerText = val.toFixed(1);
    if (spark) {
        spark.lodSplatScale = val;
    }
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
