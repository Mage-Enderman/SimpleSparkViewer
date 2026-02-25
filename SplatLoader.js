import { SplatMesh } from '@sparkjsdev/spark';

let currentSplatMesh = null;

/**
 * Loads a splat file into the scene.
 * @param {THREE.Scene} scene 
 * @param {string} url 
 * @param {boolean} isPaged Whether to use paged loading (for .RAD files)
 * @param {string} extension Optional file extension for format identification
 * @param {string} fileName Optional file name for format identification
 * @param {boolean} generateLod Whether to generate Level of Detail (LOD) nodes
 */
export function loadSplat(scene, url, isPaged = false, extension = '', fileName = '', generateLod = true) {
    if (currentSplatMesh) {
        scene.remove(currentSplatMesh);
        currentSplatMesh.dispose();
    }

    let parsedFileType = extension.replace('.', '').toLowerCase();
    if (parsedFileType === 'sog') {
        parsedFileType = 'sogs';
    } else if (parsedFileType === 'splat') {
        parsedFileType = 'antisplat';
    }

    // 2. Native LOD & Memory Paging
    // utilize Spark 2.0's native Level of Detail (LoD) Splat Tree
    currentSplatMesh = new SplatMesh({
        url: url,
        fileName: fileName,
        fileType: parsedFileType, // Explicitly set file type
        lod: generateLod,  // Enable LOD system dynamically based on UI checkbox
        paged: isPaged,    // Enable LRU paging if it's a .RAD file
    });

    // Positioning
    currentSplatMesh.position.set(0, 0, 0);

    scene.add(currentSplatMesh);

    return currentSplatMesh;
}
