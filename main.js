// Configuration (conservative adjustments only)
const config = {
    particleSize: 0.8,
    mouseRadius: 50,
    mouseStrength: 200,
    morphSpeed: 0.05,

    // Conservative delta scale (slightly larger than before, not huge)
    deltaLogoScale: 0.05,    // small increase from 0.025 to avoid bottom clipping
    deltaColorBoost: 1.05,   // slight color boost only
    deltaZSpread: 0.2,       // preserve original shallow depth
    deltaYOffset: 1.5,       // small upward nudge to avoid bottom cut-off

    // Keep matrix values as they were to avoid breaking layout
    matrixLogoScale: 0.172,
    matrixYOffset: 0,

    // Preserve camera-related factor used elsewhere
    cameraZoomFactor: 1.5,

    textureSize: 256,

    // Flocking parameters (unchanged)
    separationDistance: 20.0,
    alignmentDistance: 20.0,
    cohesionDistance: 20.0,
    freedomFactor: 0.75,
    bounds: 100,
    speedLimit: 9.0
};
config.particleCount = config.textureSize * config.textureSize;


// State
let currentLogo = 'matrix';
let isMorphing = false;
let isIdle = true;
let isFlocking = false;
let targetPositions = null;

// Three.js setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// GPGPU Setup
const gpgpu = {
    positionTextures: [],
    velocityTextures: [],
    positionTargets: [],
    velocityTargets: [],
    simulationUniforms: {
        positions: { value: null },
        velocities: { value: null },
        originalPositions: { value: null },
        targetPositions: { value: null },
        mousePosition: { value: new THREE.Vector3(-1000, -1000, -1000) },
        mouseRadius: { value: config.mouseRadius },
        mouseStrength: { value: config.mouseStrength },
        morphProgress: { value: 0 },
        morphSpeed: { value: config.morphSpeed },
        deltaTime: { value: 0 },
        isMorphing: { value: false },
        isIdle: { value: true },
        isFlocking: { value: false },
        separationDistance: { value: config.separationDistance },
        alignmentDistance: { value: config.alignmentDistance },
        cohesionDistance: { value: config.cohesionDistance },
        freedomFactor: { value: config.freedomFactor },
        bounds: { value: config.bounds },
        speedLimit: { value: config.speedLimit },
        time: { value: 0 }
    },
    renderUniforms: {
        positions: { value: null },
        colors: { value: null },
        sizes: { value: null },
        particleSize: { value: config.particleSize }
    }
};

// Helper function to copy texture to render target
function copyTextureToRenderTarget(texture, renderTarget) {
    const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ map: texture })
    );
    const scene = new THREE.Scene();
    scene.add(quad);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
}

// Create data texture
function createDataTexture(size, data = null) {
    if (!data) {
        data = new Float32Array(size * size * 4);
        for (let i = 0; i < size * size * 4; i++) {
            data[i] = 0;
        }
    }
    const texture = new THREE.DataTexture(
        data, size, size, 
        THREE.RGBAFormat, THREE.FloatType
    );
    texture.needsUpdate = true;
    return texture;
}

function initGPGPU() {
    const size = config.textureSize;
    
    // Create position textures (ping-pong)
    gpgpu.positionTextures[0] = createDataTexture(size);
    gpgpu.positionTextures[1] = createDataTexture(size);
    
    // Create velocity textures (ping-pong)
    gpgpu.velocityTextures[0] = createDataTexture(size);
    gpgpu.velocityTextures[1] = createDataTexture(size);
    
    // Create render targets
    for (let i = 0; i < 2; i++) {
        gpgpu.positionTargets[i] = new THREE.WebGLRenderTarget(
            size, size, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                format: THREE.RGBAFormat,
                type: THREE.FloatType,
                stencilBuffer: false
            }
        );
        
        gpgpu.velocityTargets[i] = new THREE.WebGLRenderTarget(
            size, size, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                format: THREE.RGBAFormat,
                type: THREE.FloatType,
                stencilBuffer: false
            }
        );
    }
    
    // Set initial uniforms
    gpgpu.simulationUniforms.originalPositions.value = null;
    gpgpu.simulationUniforms.targetPositions.value = null;
    gpgpu.simulationUniforms.mousePosition.value.set(-1000, -1000, -1000);
    gpgpu.simulationUniforms.mouseRadius.value = config.mouseRadius;
    gpgpu.simulationUniforms.mouseStrength.value = config.mouseStrength;
    gpgpu.simulationUniforms.morphProgress.value = 0;
    gpgpu.simulationUniforms.morphSpeed.value = config.morphSpeed;
    gpgpu.simulationUniforms.deltaTime.value = 0;
    gpgpu.simulationUniforms.isMorphing.value = false;
    gpgpu.simulationUniforms.positions.value = gpgpu.positionTextures[0];
    gpgpu.simulationUniforms.velocities.value = gpgpu.velocityTextures[0];
    gpgpu.simulationUniforms.isIdle.value = true;
    gpgpu.simulationUniforms.isFlocking.value = false;
    
    // Simulation materials
    gpgpu.velocityMaterial = new THREE.ShaderMaterial({
        uniforms: gpgpu.simulationUniforms,
        vertexShader: simulationVertexShader,
        fragmentShader: velocityFragmentShader
    });

    gpgpu.positionMaterial = new THREE.ShaderMaterial({
        uniforms: gpgpu.simulationUniforms,
        vertexShader: simulationVertexShader,
        fragmentShader: positionFragmentShader
    });
    
    // Fullscreen quad & scene/camera for sim passes
    gpgpu.simulationMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gpgpu.velocityMaterial);
    gpgpu.simulationScene = new THREE.Scene();
    gpgpu.simulationScene.add(gpgpu.simulationMesh);
    gpgpu.simulationCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // Create render material
    gpgpu.renderMaterial = new THREE.ShaderMaterial({
        uniforms: gpgpu.renderUniforms,
        vertexShader: renderVertexShader,
        fragmentShader: renderFragmentShader,
        transparent: true,
        blending: THREE.NormalBlending
    });
    
    // Create particle system
    const particlesGeometry = new THREE.BufferGeometry();
    const particleCount = config.particleCount;
    
    // Create indices for the particles
    const indices = new Uint32Array(particleCount);
    for (let i = 0; i < particleCount; i++) indices[i] = i;
    
    // Create UV coordinates for texture lookup
    const uvs = new Float32Array(particleCount * 2);
    for (let i = 0; i < particleCount; i++) {
        const x = (i % config.textureSize) / config.textureSize;
        const y = Math.floor(i / config.textureSize) / config.textureSize;
        uvs[i * 2] = x;
        uvs[i * 2 + 1] = y;
    }
    
    particlesGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    particlesGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    particlesGeometry.setDrawRange(0, particleCount);
    
    gpgpu.particleSystem = new THREE.Points(particlesGeometry, gpgpu.renderMaterial);
    scene.add(gpgpu.particleSystem);
}

const simulationVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// Updated Velocity shader with flocking behavior
const velocityFragmentShader = `
    precision highp float;

    uniform sampler2D positions;
    uniform sampler2D velocities;
    uniform sampler2D originalPositions;
    uniform sampler2D targetPositions;

    uniform vec3  mousePosition;
    uniform float mouseRadius;
    uniform float mouseStrength;

    uniform float morphProgress;
    uniform float deltaTime;
    uniform bool  isMorphing;
    uniform bool  isIdle;
    uniform bool  isFlocking;

    uniform float separationDistance;
    uniform float alignmentDistance;
    uniform float cohesionDistance;
    uniform float freedomFactor;
    uniform float bounds;
    uniform float speedLimit;
    uniform float time;

    varying vec2 vUv;

    const float PI = 3.141592653589793;
    const float PI_2 = PI * 2.0;
    const float textureSize = ${config.textureSize}.0;

    float zoneRadius = 40.0;
    float zoneRadiusSquared = 1600.0;

    float separationThresh = 0.45;
    float alignmentThresh = 0.65;

    float rand( vec2 co ) {
        return fract( sin( dot( co.xy, vec2(12.9898,78.233) ) ) * 43758.5453 );
    }

    void main() {
        vec3 pos = texture2D(positions, vUv).xyz;
        vec4 vel4 = texture2D(velocities, vUv);
        vec3 vel = vel4.xyz;
        float maxLife = max(vel4.w, 1.0);

        vec3 homePos   = texture2D(originalPositions, vUv).xyz;
        vec3 targetPos = isMorphing ? texture2D(targetPositions, vUv).xyz : homePos;

        // Morph easing (staggered)
        float t = clamp(morphProgress / 3.0, 0.0, 1.0);
        float delay = fract(sin(dot(vUv, vec2(91.345, 47.853))) * 43758.5453) * 0.5;
        float particleT = clamp((t - delay) / (1. - delay), 0.0, 1.0);
        float easedT = particleT * particleT * (3.0 - 2.0 * particleT);

        // Attraction toward target (strong when morphing), or gentle settle to home when idle
        vec3 desire = (isMorphing ? targetPos : homePos) - pos;
        float attractStrength = isMorphing ? (0.9 * easedT + 0.1) : 0.05;
        vel += desire * attractStrength;

        // Mouse repulsion only when not morphing and not idle-locked
        if (!isMorphing && !isIdle) {
            float distToMouse = distance(pos, mousePosition);
            if (distToMouse < mouseRadius) {
                vec3 dir = normalize(pos - mousePosition);
                float force = (mouseRadius - distToMouse) / mouseRadius * mouseStrength;
                vel += dir * force;
            }
        }

        // Flocking behavior during morph
        if (isFlocking && isMorphing && particleT > 0.2 && particleT < 0.8) {
            zoneRadius = separationDistance + alignmentDistance + cohesionDistance;
            separationThresh = separationDistance / zoneRadius;
            alignmentThresh = ( separationDistance + alignmentDistance ) / zoneRadius;
            zoneRadiusSquared = zoneRadius * zoneRadius;

            // Apply bounds
            if (length(pos) > bounds) {
                vel -= normalize(pos) * deltaTime * 5.0;
            }

            // Sample neighboring particles
            for (float y = 0.0; y < textureSize; y += 4.0) {
                for (float x = 0.0; x < textureSize; x += 4.0) {
                    vec2 ref = vec2(x + 0.5, y + 0.5) / textureSize;
                    
                    // Skip self
                    if (distance(ref, vUv) < 0.001) continue;
                    
                    vec3 otherPos = texture2D(positions, ref).xyz;
                    vec3 otherVel = texture2D(velocities, ref).xyz;
                    
                    vec3 dir = otherPos - pos;
                    float dist = length(dir);
                    
                    if (dist < 0.0001) continue;
                    
                    float distSquared = dist * dist;
                    
                    if (distSquared > zoneRadiusSquared) continue;
                    
                    float percent = distSquared / zoneRadiusSquared;
                    
                    // Separation
                    if (percent < separationThresh) {
                        float f = (separationThresh / percent - 1.0) * deltaTime;
                        vel -= normalize(dir) * f;
                    } 
                    // Alignment
                    else if (percent < alignmentThresh) {
                        float threshDelta = alignmentThresh - separationThresh;
                        float adjustedPercent = (percent - separationThresh) / threshDelta;
                        float f = (0.5 - cos(adjustedPercent * PI_2) * 0.5 + 0.5) * deltaTime;
                        vel += normalize(otherVel) * f;
                    } 
                    // Cohesion
                    else {
                        float threshDelta = 1.0 - alignmentThresh;
                        float adjustedPercent = (threshDelta == 0.0) ? 1.0 : (percent - alignmentThresh) / threshDelta;
                        float f = (0.5 - (cos(adjustedPercent * PI_2) * -0.5 + 0.5)) * deltaTime;
                        vel += normalize(dir) * f;
                    }
                }
            }

            // Speed limit
            if (length(vel) > speedLimit) {
                vel = normalize(vel) * speedLimit;
            }
        }

        // Damping
        vel *= 0.90;

        gl_FragColor = vec4(vel, maxLife);
    }
`;

const positionFragmentShader = `
    precision highp float;

    uniform sampler2D positions;
    uniform sampler2D velocities;
    uniform float deltaTime;

    varying vec2 vUv;

    void main() {
        vec4 pos4 = texture2D(positions, vUv);
        vec3 pos = pos4.xyz;
        float life = pos4.w;

        vec3 vel = texture2D(velocities, vUv).xyz;

        // Integrate
        pos += vel * deltaTime;

        // Keep alpha/life stable and visible
        life = 1.0;

        gl_FragColor = vec4(pos, life);
    }
`;

const renderVertexShader = `
    precision highp float;

    uniform sampler2D positions;
    uniform sampler2D colors;
    uniform sampler2D sizes;
    uniform float particleSize;

    varying vec4 vColor;
    varying float vSize;

    void main() {
        vec4 positionData = texture2D(positions, uv);
        vec3 pos = positionData.xyz;
        float life = positionData.w;
        
        vec4 colorData = texture2D(colors, uv);
        vColor = colorData;
        
        float sizeData = texture2D(sizes, uv).r;
        vSize = particleSize * sizeData;
        
        vColor.a = clamp(life, 0.0, 1.0);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = vSize * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const renderFragmentShader = `
    precision highp float;

    varying vec4 vColor;
    varying float vSize;

    void main() {
        gl_FragColor = vColor;
        vec2 coord = gl_PointCoord - vec2(0.5);
        if (length(coord) > 0.5) {
            discard;
        }
    }
`;

function positionCamera() {
    camera.position.z = 80;  
    camera.lookAt(0, 0, 0);
}

// Utility: Load image and extract pixel data
function loadImageData(url) {
    return new Promise((resolve, reject) => {
        new THREE.TextureLoader().load(url, texture => {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            const img = texture.image;

            canvas.width = img.width;
            canvas.height = img.height;
            context.drawImage(img, 0, 0, img.width, img.height);

            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            resolve({
                canvas,
                context,
                data: imageData.data,
                width: canvas.width,
                height: canvas.height
            });
        }, undefined, reject);
    });
}
function processLogoData(data, logoType) {
    const points = [];
    const dataArray = data.data;
    const scale = logoType === 'matrix' ? config.matrixLogoScale : config.deltaLogoScale;
    const zSpread = logoType === 'matrix' ? 5 : config.deltaZSpread;

    // Sample every 2 pixels (keeps density reasonable)
    for (let y = 0; y < data.height; y += 2) {
        for (let x = 0; x < data.width; x += 2) {
            const index = (y * data.width + x) * 4;
            const r = dataArray[index];
            const g = dataArray[index + 1];
            const b = dataArray[index + 2];
            const a = dataArray[index + 3];

            // Skip transparent/near-white pixels
            if (a <= 10 || (r > 250 && g > 250 && b > 250)) continue;

            let normalizedR = r / 255;
            let normalizedG = g / 255;
            let normalizedB = b / 255;

            if (logoType === 'delta') {
                normalizedR = Math.min(normalizedR * config.deltaColorBoost, 1.0);
                normalizedG = Math.min(normalizedG * config.deltaColorBoost, 1.0);
                normalizedB = Math.min(normalizedB * config.deltaColorBoost, 1.0);
            }

            // Use scale directly (no widthRatio distortion)
            const jitter = 0.05; // small jitter for crispness
            const px = ((x - data.width / 2) + (Math.random() - 0.5) * jitter) * scale;
            const py = ((data.height / 2 - y) + (Math.random() - 0.5) * jitter) * scale
                       + (logoType === 'delta' ? config.deltaYOffset : config.matrixYOffset);

            // Keep z = 0 for compatibility with existing simulation unless you want depth
            const pz = 0;

            points.push({
                x: px,
                y: py,
                z: pz,
                r: normalizedR,
                g: normalizedG,
                b: normalizedB,
                size: logoType === 'matrix'
                    ? 0.8 + (1 - (normalizedR + normalizedG + normalizedB) / 3) * 0.4
                    : 1.0
            });
        }
    }

    const size = config.textureSize;
    const positionArray = new Float32Array(size * size * 4);
    const colorArray = new Float32Array(size * size * 4);
    const sizeArray = new Float32Array(size * size * 4);

    const step = Math.max(1, Math.floor(points.length / config.particleCount));

    for (let i = 0; i < config.particleCount; i++) {
        const pointIndex = Math.min(i * step, points.length - 1);
        const point = points[pointIndex];

        // Fallback if points array is empty (defensive)
        const px = point ? point.x : 0;
        const py = point ? point.y : 0;
        const pz = point ? point.z : 0;
        const pr = point ? point.r : 0;
        const pg = point ? point.g : 0;
        const pb = point ? point.b : 0;
        const psz = point ? point.size : 1.0;

        positionArray[i * 4] = px;
        positionArray[i * 4 + 1] = py;
        positionArray[i * 4 + 2] = pz;
        positionArray[i * 4 + 3] = 1.0;

        colorArray[i * 4] = pr;
        colorArray[i * 4 + 1] = pg;
        colorArray[i * 4 + 2] = pb;
        colorArray[i * 4 + 3] = 1.0;

        sizeArray[i * 4] = psz;
    }

    const positionTexture = createDataTexture(size, positionArray);
    const colorTexture = createDataTexture(size, colorArray);
    const sizeTexture = createDataTexture(size, sizeArray);

    if (logoType === 'matrix') {
        gpgpu.matrixPositionTexture = positionTexture;
        gpgpu.matrixColorTexture = colorTexture;
        gpgpu.matrixSizeTexture = sizeTexture;
    } else {
        gpgpu.deltaPositionTexture = positionTexture;
        gpgpu.deltaColorTexture = colorTexture;
        gpgpu.deltaSizeTexture = sizeTexture;
    }
}

function initParticles(matrixData, deltaData) {
    // Process logo data into textures
    processLogoData(matrixData, 'matrix');
    processLogoData(deltaData, 'delta');
    
    // Verify textures were created
    if (!gpgpu.matrixPositionTexture || !gpgpu.deltaPositionTexture) {
        console.error("Failed to create logo textures");
        return;
    }
    
    // Set initial positions (Matrix first)
    gpgpu.simulationUniforms.originalPositions.value = gpgpu.matrixPositionTexture;
    
    // Copy initial positions to simulation texture (both ping-pong buffers)
    copyTextureToRenderTarget(gpgpu.simulationUniforms.originalPositions.value, gpgpu.positionTargets[0]);
    copyTextureToRenderTarget(gpgpu.simulationUniforms.originalPositions.value, gpgpu.positionTargets[1]);
    
    // Initialize velocities to zero
    const zeroTexture = createDataTexture(config.textureSize);
    copyTextureToRenderTarget(zeroTexture, gpgpu.velocityTargets[0]);
    copyTextureToRenderTarget(zeroTexture, gpgpu.velocityTargets[1]);
    
    // Set render uniforms
    gpgpu.renderUniforms.positions.value = gpgpu.positionTargets[0].texture;
    gpgpu.renderUniforms.colors.value = gpgpu.matrixColorTexture;
    gpgpu.renderUniforms.sizes.value = gpgpu.matrixSizeTexture;
}

// Mouse interaction
const mouse = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let mouseWorldPos = new THREE.Vector3(-1000, -1000, -1000);

window.addEventListener('mousemove', (event) => {
    // Only allow mouse interaction when not in precise logo formation mode
    if (!isMorphing && isIdle) {
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        
        // Update raycaster
        raycaster.setFromCamera(mouse, camera);
        
        // Create a temporary sphere for intersection testing
        const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
        const ray = new THREE.Ray();
        raycaster.ray.copy(ray);
        
        if (ray.intersectSphere(sphere, mouseWorldPos)) {
            mouseWorldPos.multiplyScalar(50);
        } else {
            mouseWorldPos.set(-1000, -1000, -1000);
        }
    }
});

window.addEventListener('click', () => {
    // Prevent clicks during morph
    if (isMorphing) return;

    // Begin morphing
    isIdle = false;
    isMorphing = true;

    gpgpu.simulationUniforms.isIdle.value = false;
    gpgpu.simulationUniforms.isMorphing.value = true;

    // Flip current logo
    currentLogo = currentLogo === 'matrix' ? 'delta' : 'matrix';

    // Reset morph progress (seconds)
    gpgpu.simulationUniforms.morphProgress.value = 0;

    // Set target positions (destination of morph)
    gpgpu.simulationUniforms.targetPositions.value =
        currentLogo === 'matrix'
            ? gpgpu.matrixPositionTexture
            : gpgpu.deltaPositionTexture;

    // Update render textures (for color and size)
    gpgpu.renderUniforms.colors.value =
        currentLogo === 'matrix'
            ? gpgpu.matrixColorTexture
            : gpgpu.deltaColorTexture;

    gpgpu.renderUniforms.sizes.value =
        currentLogo === 'matrix'
            ? gpgpu.matrixSizeTexture
            : gpgpu.deltaSizeTexture;

    // Update button text
    document.getElementById('toggleLogo').textContent = 
        `Switch to ${currentLogo === 'matrix' ? 'Delta' : 'Matrix'} Logo`;

    // Disable mouse interaction during morph
    gpgpu.simulationUniforms.mousePosition.value.set(-1000, -1000, -1000);
});

// UI event handlers
document.getElementById('toggleLogo').addEventListener('click', () => {
    window.dispatchEvent(new Event('click'));
});

document.getElementById('toggleFlocking').addEventListener('click', function() {
    isFlocking = !isFlocking;
    gpgpu.simulationUniforms.isFlocking.value = isFlocking;
    this.textContent = isFlocking ? 'Disable Flocking' : 'Enable Flocking';
});

// Animation loop
const clock = new THREE.Clock();
let currentPositionTarget = 0;
let currentVelocityTarget = 0;

function animate() {
    requestAnimationFrame(animate);

    const deltaTime = clock.getDelta();

    // === Update shared uniforms ===
    gpgpu.simulationUniforms.deltaTime.value = deltaTime;
    gpgpu.simulationUniforms.time.value += deltaTime;

    // Mouse only when not morphing and idle "interaction mode" is on
    if (!isMorphing && isIdle) {
        gpgpu.simulationUniforms.mousePosition.value.copy(mouseWorldPos);
    } else {
        gpgpu.simulationUniforms.mousePosition.value.set(-1000, -1000, -1000);
    }

    // === Ping-pong ===
    const nextPositionTarget = 1 - currentPositionTarget;
    const nextVelocityTarget = 1 - currentVelocityTarget;

    // -------- Pass 1: Velocity update --------
    gpgpu.simulationUniforms.positions.value  = gpgpu.positionTargets[currentPositionTarget].texture;
    gpgpu.simulationUniforms.velocities.value = gpgpu.velocityTargets[currentVelocityTarget].texture;
    gpgpu.simulationMesh.material = gpgpu.velocityMaterial;

    renderer.setRenderTarget(gpgpu.velocityTargets[nextVelocityTarget]);
    renderer.render(gpgpu.simulationScene, gpgpu.simulationCamera);

    // -------- Pass 2: Position integrate --------
    gpgpu.simulationUniforms.positions.value  = gpgpu.positionTargets[currentPositionTarget].texture;
    gpgpu.simulationUniforms.velocities.value = gpgpu.velocityTargets[nextVelocityTarget].texture;
    gpgpu.simulationMesh.material = gpgpu.positionMaterial;

    renderer.setRenderTarget(gpgpu.positionTargets[nextPositionTarget]);
    renderer.render(gpgpu.simulationScene, gpgpu.simulationCamera);

    // Reset render target
    renderer.setRenderTarget(null);

    // === Set updated texture for rendering pass ===
    gpgpu.renderUniforms.positions.value = gpgpu.positionTargets[nextPositionTarget].texture;

    // === Render the particle system ===
    renderer.render(scene, camera);

    // === Swap ping-pong buffers ===
    currentPositionTarget = nextPositionTarget;
    currentVelocityTarget = nextVelocityTarget;

    // === Morph progression logic ===
    if (isMorphing) {
        gpgpu.simulationUniforms.morphProgress.value += deltaTime;

        if (gpgpu.simulationUniforms.morphProgress.value >= 3.0) {
            // Morph complete — lock into final logo
            isMorphing = false;
            isIdle = true;

            gpgpu.simulationUniforms.isMorphing.value = false;
            gpgpu.simulationUniforms.isIdle.value = true;

            // Now that morph is done, set new home position
            gpgpu.simulationUniforms.originalPositions.value =
                currentLogo === 'matrix'
                    ? gpgpu.matrixPositionTexture
                    : gpgpu.deltaPositionTexture;

            // Clear target
            gpgpu.simulationUniforms.targetPositions.value = null;
        }
    }
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Start the application
Promise.all([
    loadImageData('./Matrix_CMYK_Logo.png'),
    loadImageData('./Delta_Logo.png')
]).then(([matrixData, deltaData]) => {
    initGPGPU();
    initParticles(matrixData, deltaData);
    positionCamera(); 
    animate();
}).catch(error => {
    console.error("Error loading images:", error);
});
