import * as THREE from 'three';

export class MultiplayerManager {
    constructor(scene, onModelReceived, onRangeRequest) {
        this.scene = scene;
        this.onModelReceived = onModelReceived;
        this.onRangeRequest = onRangeRequest;
        this.peer = null;
        this.connections = new Map(); // id -> DataConnection
        this.avatars = new Map(); // id -> Object3D
        this.isHost = false;
        this.roomId = null;
        this.localPlayerData = {
            head: { pos: [0, 0, 0], rot: [0, 0, 0, 1] },
            leftHand: { pos: [0, 0, 0], rot: [0, 0, 0, 1], active: false },
            rightHand: { pos: [0, 0, 0], rot: [0, 0, 0, 1], active: false }
        };

        this.handGeometry = new THREE.BoxGeometry(0.05, 0.02, 0.1);
        this.handMaterial = new THREE.MeshStandardMaterial({ color: 0x888888 });
    }

    async smartInit(id) {
        if (typeof Peer === 'undefined') {
            console.error("PeerJS not loaded! Please check your internet connection and verify the CDN script is included.");
            document.getElementById('status').innerText = "Status: PeerJS library missing!";
            return null;
        }
        if (!id) return this.host();

        return new Promise((resolve) => {
            console.log("Attempting smart init for ID:", id);
            // Try to be the host of this ID
            this.peer = new Peer(id, { debug: 2 });

            this.peer.on('open', (openedId) => {
                console.log('SmartInit: Hosting room', openedId);
                this.isHost = true;
                this.roomId = openedId;
                window.location.hash = this.roomId;

                this.peer.on('connection', (conn) => this.setupConnection(conn));
                resolve(openedId);
            });

            this.peer.on('error', (err) => {
                if (err.type === 'unavailable-id') {
                    console.log('SmartInit: ID taken, attempting to join instead...');
                    // Host exists, so we join
                    this.peer.destroy();
                    this.peer = new Peer({ debug: 2 }); // Get a random ID for ourselves
                    this.peer.on('open', () => {
                        this.isHost = false;
                        this.roomId = id;
                        const conn = this.peer.connect(id);
                        this.setupConnection(conn);

                        this.peer.on('connection', (conn) => this.setupConnection(conn));
                        resolve(id);
                    });
                } else {
                    console.error('PeerJS error:', err);
                }
            });
        });
    }

    async initPeer() {
        if (this.peer) return;
        if (typeof Peer === 'undefined') {
            throw new Error("PeerJS not loaded");
        }
        return new Promise((resolve, reject) => {
            this.peer = new Peer({ debug: 2 });
            this.peer.on('open', (id) => {
                console.log('My peer ID is: ' + id);
                this.peer.on('connection', (conn) => this.setupConnection(conn));
                resolve(id);
            });
            this.peer.on('error', (err) => {
                console.error('PeerJS error:', err);
                reject(err);
            });
        });
    }

    async host() {
        await this.initPeer();
        this.isHost = true;
        this.roomId = this.peer.id;
        window.location.hash = this.roomId;
        return this.roomId;
    }

    async join(hostId) {
        await this.initPeer();
        this.isHost = false;
        this.roomId = hostId;
        const conn = this.peer.connect(hostId);
        this.setupConnection(conn);
        return hostId;
    }

    setupConnection(conn) {
        conn.on('open', () => {
            console.log('Connected to:', conn.peer);
            this.connections.set(conn.peer, conn);

            // If host, send current model info and the updated peer list
            if (this.isHost) {
                this.broadcastModelInfo(conn);
                this.broadcastPeerList();
            }
        });

        conn.on('data', (data) => {
            this.handleData(conn.peer, data);
        });

        conn.on('error', (err) => {
            console.error('Connection error with peer:', conn.peer, err);
            document.getElementById('status').innerText = `Status: P2P error with ${conn.peer}`;
        });

        conn.on('iceStateChanged', (state) => {
            console.log('ICE Connection state:', conn.peer, state);
            if (state === 'failed' || state === 'disconnected') {
                console.warn('ICE connection failed to', conn.peer);
            }
        });

        conn.on('close', () => {
            this.removeAvatar(conn.peer);
            this.connections.delete(conn.peer);
            if (this.isHost) {
                this.broadcastPeerList();
            }
        });
    }

    broadcastPeerList() {
        const peerIds = Array.from(this.connections.keys());
        this.broadcast({
            type: 'PEER_LIST',
            payload: peerIds
        });
    }

    handleData(peerId, data) {
        switch (data.type) {
            case 'SYNC':
                // Note: The scale is passed down from main.js when updateAvatar is called, so we 
                // store the raw SYNced payload and update positions in the render loop.
                // However, our multiplayer manager directly triggers updateAvatar on receipt.
                // We will modify handleData to accept the current scale, or allow main.js to update
                // avatars directly in animate loop. Let's just track the raw synced state here.
                this.updateAvatar(peerId, data.payload, this.currentModelScale || 1.0);
                break;
            case 'MODEL_ANNOUNCE':
                if (this.onModelReceived) this.onModelReceived(peerId, data.payload);
                break;
            case 'MODEL_DATA_REQ':
            case 'MODEL_CHUNK_REQ':
                if (this.isHost && this.onRangeRequest) {
                    this.onRangeRequest(peerId, data.type, data.payload);
                }
                break;
            case 'MODEL_DATA_CHUNK':
            case 'MODEL_CHUNK':
                // Handle chunk if we are a client
                window.dispatchEvent(new CustomEvent('peer-model-data', { detail: data.payload }));
                break;
            case 'PEER_LIST':
                this.handlePeerList(data.payload);
                break;
        }
    }

    handlePeerList(peerIds) {
        if (this.isHost) return; // Only clients need to connect horizontally
        for (const id of peerIds) {
            // Don't connect to ourselves, don't connect to the Host (we already are), and don't duplicate
            if (id !== this.peer.id && id !== this.roomId && !this.connections.has(id)) {
                console.log(`Mesh networking: Discovered peer ${id}, connecting...`);
                const conn = this.peer.connect(id);
                this.setupConnection(conn);
            }
        }
    }

    updateAvatar(id, data, currentScale = 1.0) {
        let avatar = this.avatars.get(id);
        if (!avatar) {
            avatar = this.createAvatar();
            this.avatars.set(id, avatar);
            this.scene.add(avatar);
        }

        // Apply scale to incoming positions
        const scaledHeadPos = new THREE.Vector3().fromArray(data.head.pos).multiplyScalar(currentScale);

        // Set Head
        avatar.head.position.copy(scaledHeadPos);
        avatar.head.quaternion.fromArray(data.head.rot);

        // Set Hands
        if (data.leftHand.active) {
            avatar.leftHand.visible = true;
            const scaledLeftPos = new THREE.Vector3().fromArray(data.leftHand.pos).multiplyScalar(currentScale);
            avatar.leftHand.position.copy(scaledLeftPos);
            avatar.leftHand.quaternion.fromArray(data.leftHand.rot);
        } else {
            avatar.leftHand.visible = false;
        }

        if (data.rightHand.active) {
            avatar.rightHand.visible = true;
            const scaledRightPos = new THREE.Vector3().fromArray(data.rightHand.pos).multiplyScalar(currentScale);
            avatar.rightHand.position.copy(scaledRightPos);
            avatar.rightHand.quaternion.fromArray(data.rightHand.rot);
        } else {
            avatar.rightHand.visible = false;
        }
    }

    createAvatar() {
        const group = new THREE.Group();

        // Head
        let head;
        if (this.remoteHeadModel) {
            head = this.remoteHeadModel.clone();
        } else {
            head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial({ color: 0x444444 }));
        }
        group.add(head);
        group.head = head;

        // Hands
        const leftHand = new THREE.Mesh(this.handGeometry, this.handMaterial);
        const rightHand = new THREE.Mesh(this.handGeometry, this.handMaterial);
        group.add(leftHand);
        group.add(rightHand);
        group.leftHand = leftHand;
        group.rightHand = rightHand;

        return group;
    }

    removeAvatar(id) {
        const avatar = this.avatars.get(id);
        if (avatar) {
            this.scene.remove(avatar);
            this.avatars.delete(id);
        }
    }

    broadcast(data) {
        for (const conn of this.connections.values()) {
            if (conn.open) {
                conn.send(data);
            }
        }
    }

    updateLocalState(camera, controller0, controller1, isInVR = false, currentScale = 1.0) {
        // Divide our world position by our local scale to normalize it to a 1.0x space before sending
        const headPos = camera.getWorldPosition(new THREE.Vector3());
        this.localPlayerData.head.pos = headPos.divideScalar(currentScale).toArray();
        this.localPlayerData.head.rot = camera.getWorldQuaternion(new THREE.Quaternion()).toArray();

        // Only mark hands as active if we are actually in a VR session
        if (isInVR && controller0) {
            const leftPos = controller0.getWorldPosition(new THREE.Vector3());
            this.localPlayerData.leftHand.pos = leftPos.divideScalar(currentScale).toArray();
            this.localPlayerData.leftHand.rot = controller0.getWorldQuaternion(new THREE.Quaternion()).toArray();
            this.localPlayerData.leftHand.active = true;
        } else {
            this.localPlayerData.leftHand.active = false;
        }

        if (isInVR && controller1) {
            const rightPos = controller1.getWorldPosition(new THREE.Vector3());
            this.localPlayerData.rightHand.pos = rightPos.divideScalar(currentScale).toArray();
            this.localPlayerData.rightHand.rot = controller1.getWorldQuaternion(new THREE.Quaternion()).toArray();
            this.localPlayerData.rightHand.active = true;
        } else {
            this.localPlayerData.rightHand.active = false;
        }

        this.broadcast({ type: 'SYNC', payload: this.localPlayerData });
    }

    broadcastModelInfo(specificConn = null) {
        // Implementation for main.js to hook into
    }
}
