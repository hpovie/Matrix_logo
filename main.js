// Configuration 
const config = {
    particleSize: 1.0,
    mouseRadiusIdle: 15, // Smaller radius for idle state
    mouseRadiusFlocking: 20, // Normal radius for flocking
    mouseStrength: 200,
    morphSpeed: 0.05,
    deltaLogoScale: 0.055,
    deltaColorBoost: 1.1,
    deltaZSpread: 0.15,
    deltaYOffset: 1.5,
    matrixLogoScale: 0.18,
    matrixYOffset: 0,
    matrixZSpread: 0.1,
    textureSize: 256,
    separationDistance: 20.0,
    alignmentDistance: 20.0,
    cohesionDistance: 20.0,
    freedomFactor: 0.75,
    bounds: 100,
    speedLimit: 9.0,
    // Lifecycle settings (only in idle)
    particleLifespan: 1.5, 
    respawnDelayMax: 1.0,
    // Explosion settings
    explosionStrength: 2.5,
    explosionDuration: 1.2,
    cameraFlyThroughDistance: 30, 
    predatorRadius: 20
};
config.particleCount = config.textureSize * config.textureSize;

// Flocking timing constants
const FLOCKING_DURATION = 8.0;
const TRANSITION_DURATION = 5.0;
const TOTAL_FLOCKING_TIME = FLOCKING_DURATION + TRANSITION_DURATION;

// State
let currentLogo = 'matrix';
let isMorphing = false;
let isIdle = true;
let isFlocking = false;
let flockingStartTime = null;
let flockingPhase = "idle";
let morphStartTime = null;
let explosionStartTime = null;
let isExploding = false;
let originalCameraZ = 80; // Fixed camera position

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
    positionTargets: [],
    velocityTargets: [],
    randomTexture: null,
    simulationUniforms: {
        positions: { value: null },
        velocities: { value: null },
        originalPositions: { value: null },
        targetPositions: { value: null },
        randomTexture: { value: null },
        mousePosition: { value: new THREE.Vector3(-1000, -1000, -1000) },
        mouseRadius: { value: config.mouseRadiusIdle }, // Start with idle radius
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
        time: { value: 0 },
        returnForceStrength: { value: 0 },
        // Lifecycle uniforms (only used in idle)
        particleLifespan: { value: config.particleLifespan },
        respawnDelayMax: { value: config.respawnDelayMax },
        // Explosion effect uniforms
        explosionStrength: { value: config.explosionStrength },
        explosionTime: { value: 0 },
        isExploding: { value: false },
        predatorRadius: { value: config.predatorRadius }
    },
    renderUniforms: {
        positions: { value: null },
        velocities: { value: null },
        startColors: { value: null },
        targetColors: { value: null },
        sizes: { value: null },
        particleSize: { value: config.particleSize },
        colorMix: { value: 0 },
        time: { value: 0 },
        colorStartTime: { value: 0 },
        // uniforms for render shaders
        isIdle: { value: true },
        isMorphing: { value: false }
    }
};

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
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    return texture;
}

// Create random texture for consistent per-particle randomness
function createRandomTexture(size) {
    const data = new Float32Array(size * size * 4);
    for (let i = 0; i < size * size * 4; i++) {
        data[i] = Math.random();
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    texture.needsUpdate = true;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    return texture;
}

// Helper function to copy texture to render target
function copyTextureToRenderTarget(texture, renderTarget) {
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    const tempScene = new THREE.Scene();
    tempScene.add(quad);
    const tempCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const currentRenderTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(renderTarget);
    renderer.render(tempScene, tempCamera);
    renderer.setRenderTarget(currentRenderTarget);

    material.dispose();
    quad.geometry.dispose();
}

function initGPGPU() {
    const size = config.textureSize;
    
    // Create render targets for ping-pong
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
    
    // Create and set random texture
    gpgpu.randomTexture = createRandomTexture(size);
    gpgpu.simulationUniforms.randomTexture.value = gpgpu.randomTexture;
    
    // Set initial uniforms
    gpgpu.simulationUniforms.originalPositions.value = null;
    gpgpu.simulationUniforms.targetPositions.value = null;
    gpgpu.simulationUniforms.mousePosition.value.set(-1000, -1000, -1000);
    gpgpu.simulationUniforms.morphProgress.value = 0;
    gpgpu.simulationUniforms.deltaTime.value = 0;
    gpgpu.simulationUniforms.isMorphing.value = false;
    gpgpu.simulationUniforms.isIdle.value = true;
    gpgpu.simulationUniforms.isFlocking.value = false;
    gpgpu.simulationUniforms.time.value = 0;
    gpgpu.simulationUniforms.isExploding.value = false;
    gpgpu.simulationUniforms.explosionTime.value = 0;
    
    // Set initial render uniforms
    gpgpu.renderUniforms.isIdle.value = true;
    gpgpu.renderUniforms.isMorphing.value = false;
    
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
    
    // Fullscreen quad for simulation passes
    gpgpu.simulationMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gpgpu.velocityMaterial);
    gpgpu.simulationScene = new THREE.Scene();
    gpgpu.simulationScene.add(gpgpu.simulationMesh);
    gpgpu.simulationCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // Render material for particles (with lifecycle support only in idle)
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
    
    // Create UV coordinates for texture lookup
    const uvs = new Float32Array(particleCount * 2);
    for (let i = 0; i < particleCount; i++) {
        const x = (i % config.textureSize) / config.textureSize;
        const y = Math.floor(i / config.textureSize) / config.textureSize;
        uvs[i * 2] = x;
        uvs[i * 2 + 1] = y;
    }
    
    const indices = new Uint32Array(particleCount);
    for (let i = 0; i < particleCount; i++) indices[i] = i;
    
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

const velocityFragmentShader = `
    precision highp float;

    uniform sampler2D positions;
    uniform sampler2D velocities;
    uniform sampler2D originalPositions;
    uniform sampler2D targetPositions;
    uniform sampler2D randomTexture;

    uniform vec3 mousePosition;
    uniform float mouseRadius;
    uniform float mouseStrength;
    uniform float predatorRadius;

    uniform float morphProgress;
    uniform float deltaTime;
    uniform bool isMorphing;
    uniform bool isIdle;
    uniform bool isFlocking;
    uniform bool isExploding;
    uniform float explosionStrength;
    uniform float explosionTime;

    uniform float separationDistance;
    uniform float alignmentDistance;
    uniform float cohesionDistance;
    uniform float freedomFactor;
    uniform float bounds;
    uniform float speedLimit;
    uniform float time;
    uniform float returnForceStrength;

    // Lifecycle uniforms (only used in idle)
    uniform float particleLifespan;
    uniform float respawnDelayMax;

    varying vec2 vUv;

    const float PI = 3.141592653589793;
    const float PI_2 = PI * 2.0;
    const float textureSize = ${config.textureSize}.0;

    float rand(vec2 co) {
        return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453);
    }

    void main() {
        vec3 pos = texture2D(positions, vUv).xyz;
        vec4 vel4 = texture2D(velocities, vUv);
        vec3 vel = vel4.xyz;
        float life = vel4.a;

        vec3 homePos = texture2D(originalPositions, vUv).xyz;
        vec3 targetPos = isMorphing ? texture2D(targetPositions, vUv).xyz : homePos;

        float particleRandom = texture2D(randomTexture, vUv).r;
        float particleRandom2 = texture2D(randomTexture, vUv + 0.1).r;

        // ===== LIFECYCLE MANAGEMENT (ONLY IN PURE IDLE STATE) =====
        bool isPureIdle = isIdle && !isMorphing;
        bool isActiveState = isMorphing || isFlocking;
        
        if (isPureIdle) {
            // Only apply lifecycle in pure idle state
            if (life < 0.0) {
                life += deltaTime;
                if (life < 0.0) {
                    gl_FragColor = vec4(vel, life);
                    return;
                }
                vel = vec3(0.0);
                life = 0.0;
            } else {
                life += deltaTime / particleLifespan;
            }
        } else {
            // During ANY active state (morphing or flocking), keep particles alive and visible
            life = 1.0;
        }

        // Morph easing - SMOOTHER TRANSITION
        float t = clamp(morphProgress / 3.0, 0.0, 1.0);
        float delay = fract(sin(dot(vUv, vec2(91.345, 47.853))) * 43758.5453) * 0.5;
        float particleT = clamp((t - delay) / (1. - delay), 0.0, 1.0);
        float easedT = particleT * particleT * (3.0 - 2.0 * particleT);

        // ATTRACTION LOGIC - INCREASED ATTRACTION DURING FLOCKING
        vec3 desire = (isMorphing ? targetPos : homePos) - pos;
        float attractStrength = 0.0;

        if (isPureIdle) {
            attractStrength = 0.01; // Very weak in pure idle
        } else if (isFlocking && isMorphing) {
            // INCREASED BASE ATTRACTION + RETURN FORCE
            attractStrength = 0.15 + (returnForceStrength * 0.5); // Combine a base force with the ramping return force
        } else if (isMorphing) {
            // Normal morphing without flocking
            attractStrength = 0.1 * easedT;
        }

        vel += desire * attractStrength;

        float distToMouse = distance(pos, mousePosition);
        
        // IDLE MOUSE INTERACTION
        if (isPureIdle && distToMouse < mouseRadius) {
            vec3 dir = normalize(pos - mousePosition);
            float force = (mouseRadius - distToMouse) / mouseRadius * mouseStrength;
            vel += dir * force;
            
            // Lifecycle in pure idle only
            float distFromHome = distance(pos, homePos);
            if (distFromHome > mouseRadius * 2.0) {
                float respawnDelay = particleRandom * respawnDelayMax;
                life = -respawnDelay;
                vel = vec3(0.0);
            }
        }
        
        // PREDATOR BEHAVIOR during flocking
        else if (isFlocking && isMorphing && distToMouse < predatorRadius) {
            vec3 fleeDir = normalize(pos - mousePosition);
            float force = (predatorRadius - distToMouse) / predatorRadius * mouseStrength * 0.3;
            vel += fleeDir * force;
        }

        // EXPLOSIVE EFFECT - IMPROVED
        if (isExploding && explosionTime < 1.5) {
            float explosionProgress = explosionTime / 1.5;
            float explosionForce = explosionStrength * (1.0 - explosionProgress);
            
            vec3 explodeDir = normalize(vec3(
                (particleRandom - 0.5) * 2.0, 
                (particleRandom2 - 0.5) * 2.0,
                (particleRandom - 0.5) * 1.0
            ));
            
            vec3 centerDir = normalize(pos);
            explodeDir = normalize(explodeDir + centerDir * 0.3);
            
            vel += explodeDir * explosionForce * deltaTime * 8.0;
        }

        // FLOCKING FORCES - IMPROVED FROM EXAMPLE
        if (isFlocking && isMorphing && particleT > 0.1 && particleT < 0.9) {
            float zoneRadius = separationDistance + alignmentDistance + cohesionDistance;
            float separationThresh = separationDistance / zoneRadius;
            float alignmentThresh = (separationDistance + alignmentDistance) / zoneRadius;
            float zoneRadiusSquared = zoneRadius * zoneRadius;

            // Smoother boundary handling
            if (length(pos) > bounds) {
                vel -= normalize(pos) * deltaTime * 3.0;
            }

            // Sample neighbors for flocking
            for (float y = 0.0; y < textureSize; y += 6.0) {
                for (float x = 0.0; x < textureSize; x += 6.0) {
                    vec2 ref = vec2(x + 0.5, y + 0.5) / textureSize;
                    if (distance(ref, vUv) < 0.001) continue;

                    vec3 otherPos = texture2D(positions, ref).xyz;
                    vec3 otherVel = texture2D(velocities, ref).xyz;

                    vec3 dir = otherPos - pos;
                    float dist = length(dir);
                    if (dist < 0.0001) continue;

                    float distSquared = dist * dist;
                    if (distSquared > zoneRadiusSquared) continue;

                    float percent = distSquared / zoneRadiusSquared;

                    if (percent < separationThresh) {
                        float f = (separationThresh / percent - 1.0) * deltaTime * 1.2;
                        vel -= normalize(dir) * f;
                    }
                    else if (percent < alignmentThresh) {
                        float threshDelta = alignmentThresh - separationThresh;
                        float adjustedPercent = (percent - separationThresh) / threshDelta;
                        float f = (0.5 - cos(adjustedPercent * PI_2) * 0.5 + 0.5) * deltaTime * 1.1;
                        vel += normalize(otherVel) * f;
                    }
                    else {
                        float threshDelta = 1.0 - alignmentThresh;
                        float adjustedPercent = (threshDelta == 0.0) ? 1.0 : (percent - alignmentThresh) / threshDelta;
                        float f = (0.5 - (cos(adjustedPercent * PI_2) * -0.5 + 0.5)) * deltaTime * 1.2;
                        vel += normalize(dir) * f;
                    }
                }
            }

            // Smooth speed limiting
            float currentSpeed = length(vel);
            if (currentSpeed > speedLimit) {
                vel = normalize(vel) * mix(currentSpeed, speedLimit, 0.3);
            }
        }

        // Damping - adjusted for smoother behavior
        float damping = isFlocking ? 0.92 : 0.95;
        vel *= damping;
        
        // Life reset only in pure idle state
        if (isPureIdle && life >= 1.0) {
            float respawnDelay = particleRandom * respawnDelayMax;
            life = -respawnDelay;
            vel = vec3(0.0);
        }

        gl_FragColor = vec4(vel, life);
    }
`;

const positionFragmentShader = `
    precision highp float;

    uniform sampler2D positions;
    uniform sampler2D velocities;
    uniform sampler2D originalPositions;
    uniform float deltaTime;
    uniform bool isIdle;
    uniform bool isMorphing;
    uniform bool isFlocking;

    varying vec2 vUv;

    void main() {
        vec4 pos4 = texture2D(positions, vUv);
        vec3 pos = pos4.xyz;

        vec4 vel4 = texture2D(velocities, vUv);
        vec3 vel = vel4.xyz;
        float life = vel4.a;
        
        // Only apply lifecycle reset in pure idle state
        bool isPureIdle = isIdle && !isMorphing;
        if (isPureIdle && life < 0.0) {
            vec3 homePos = texture2D(originalPositions, vUv).xyz;
            gl_FragColor = vec4(homePos, 1.0);
        } else {
            // During ANY active state, update position continuously
            pos += vel * deltaTime;
            gl_FragColor = vec4(pos, 1.0);
        }
    }
`;

const renderVertexShader = `
precision highp float;

uniform sampler2D positions;
uniform sampler2D velocities;
uniform sampler2D startColors;
uniform sampler2D targetColors;
uniform sampler2D sizes;
uniform float particleSize;
uniform float colorMix;
uniform float time;
uniform float colorStartTime;
// Add missing uniforms for vertex shader
uniform bool isIdle;
uniform bool isMorphing;

varying vec4 vColor;
varying float vSize;
varying float vLife;

float rand(vec2 co) {
    return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453);
}

void main() {
    vec4 positionData = texture2D(positions, uv);
    vec3 pos = positionData.xyz;

    // Get lifecycle information from velocity texture
    vLife = texture2D(velocities, uv).a;

    // Sample both color sources
    vec4 c1 = texture2D(startColors, uv);
    vec4 c2 = texture2D(targetColors, uv);

    // Per-particle random timing
    float elapsedTime = time - colorStartTime;
    float randVal = rand(uv);
    float particleSwitchTime = 1.0 + randVal * 1.5;
    float particleTransition = smoothstep(particleSwitchTime - 0.3, particleSwitchTime + 0.3, elapsedTime);
    float finalTransition = max(particleTransition, colorMix);
    
    // Smoothly mix colors
    vColor = mix(c1, c2, finalTransition);

    float sizeData = texture2D(sizes, uv).r;
    vSize = particleSize * sizeData;

    // Alpha based on lifecycle - ONLY IN PURE IDLE STATE
    bool isPureIdle = isIdle && !isMorphing;
    if (isPureIdle && vLife < 0.0) {
        vColor.a = 0.0; // Dead particles are invisible
    } else if (isPureIdle) {
        float spawnFade = 0.2;
        float fadeOut = 0.3;
        if (vLife < spawnFade) {
            vColor.a = vLife / spawnFade; // Fade in
        } else if (vLife > 1.0 - fadeOut) {
            vColor.a = (1.0 - vLife) / fadeOut; // Fade out
        } else {
            vColor.a = 1.0; // Full visibility
        }
    } else {
        // During ANY active state (morphing or flocking), always full visibility
        vColor.a = 1.0;
    }

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = vSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
}
`;

const renderFragmentShader = `
precision highp float;

varying vec4 vColor;
varying float vSize;
varying float vLife;
// Add missing uniforms for fragment shader
uniform bool isIdle;
uniform bool isMorphing;

void main() {
    // Skip rendering if particle is dead - ONLY IN PURE IDLE STATE
    bool isPureIdle = isIdle && !isMorphing;
    if (isPureIdle && vLife < 0.0) discard;
    
    // Circular point with anti-aliasing
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);
    
    // Smooth falloff at edges
    float alpha = 1.0 - smoothstep(0.4, 0.5, dist);
    
    if (alpha < 0.01) discard;
    
    // Apply color with alpha from lifecycle (or full alpha during active states)
    gl_FragColor = vec4(vColor.rgb, vColor.a * alpha);
    
    // Subtle highlight for depth
    float highlight = pow(1.0 - dist * 1.8, 4.0) * 0.2;
    gl_FragColor.rgb += highlight;
}
`;

function positionCamera() {
    camera.position.z = originalCameraZ;  
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
    const zSpread = logoType === 'matrix' ? config.matrixZSpread : config.deltaZSpread;

    for (let y = 0; y < data.height; y += 1) {
        for (let x = 0; x < data.width; x += 1) {
            const index = (y * data.width + x) * 4;
            const r = dataArray[index];
            const g = dataArray[index + 1];
            const b = dataArray[index + 2];
            const a = dataArray[index + 3];

            if (logoType === 'matrix') {
                if (a <= 30 || (r > 230 && g > 230 && b > 230)) continue;
            } else {
                if (a <= 20 || (r > 240 && g > 240 && b > 240)) continue;
            }

            let normalizedR = r / 255;
            let normalizedG = g / 255;
            let normalizedB = b / 255;

            if (logoType === 'delta') {
                normalizedR = Math.min(normalizedR * config.deltaColorBoost, 1.0);
                normalizedG = Math.min(normalizedG * config.deltaColorBoost, 1.0);
                normalizedB = Math.min(normalizedB * config.deltaColorBoost, 1.0);
            }

            const jitter = logoType === 'matrix' ? 0.01 : 0.02;
            const px = ((x - data.width / 2) + (Math.random() - 0.5) * jitter) * scale;
            const py = ((data.height / 2 - y) + (Math.random() - 0.5) * jitter) * scale
                       + (logoType === 'delta' ? config.deltaYOffset : config.matrixYOffset);
            const pz = (Math.random() - 0.5) * zSpread;

            const size = logoType === 'matrix' 
                ? 0.8 + (1 - (normalizedR + normalizedG + normalizedB) / 3) * 0.2
                : 1.0;

            points.push({
                x: px, y: py, z: pz,
                r: normalizedR, g: normalizedG, b: normalizedB,
                size: size,
                ix: x, iy: y,
                brightness: (normalizedR + normalizedG + normalizedB) / 3
            });
        }
    }

    const size = config.textureSize;
    const positionArray = new Float32Array(size * size * 4);
    const colorArray = new Float32Array(size * size * 4);
    const sizeArray = new Float32Array(size * size * 4);

    if (points.length > 0) {
        function fisherYatesShuffle(arr) {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
        }

        if (logoType === 'matrix') {
            const BUCKETS = 32;
            const buckets = Array(BUCKETS).fill().map(() => Array(BUCKETS).fill().map(() => []));

            for (let p of points) {
                const bx = Math.floor((p.ix / data.width) * BUCKETS);
                const by = Math.floor((p.iy / data.height) * BUCKETS);
                const ix = Math.min(BUCKETS - 1, Math.max(0, bx));
                const iy = Math.min(BUCKETS - 1, Math.max(0, by));
                buckets[ix][iy].push(p);
            }

            const weightFactor = 2;
            let totalPoints = points.length;
            const bucketQuotas = [];
            let assignedTotal = 0;

            for (let i = 0; i < BUCKETS; i++) {
                for (let j = 0; j < BUCKETS; j++) {
                    const count = buckets[i][j].length;
                    const quota = Math.max(0, Math.round((count / totalPoints) * config.particleCount));
                    bucketQuotas.push({ i, j, count, quota });
                    assignedTotal += quota;
                }
            }

            let remainder = config.particleCount - assignedTotal;
            bucketQuotas.sort((a, b) => b.count - a.count);
            let k = 0;
            while (remainder > 0 && k < bucketQuotas.length) {
                bucketQuotas[k].quota += 1;
                remainder -= 1;
                k = (k + 1) % bucketQuotas.length;
            }

            const selected = [];
            for (let bq of bucketQuotas) {
                const arr = buckets[bq.i][bq.j];
                if (arr.length === 0) continue;
                
                const weighted = [];
                for (let p of arr) {
                    const times = (p.brightness > 0.8) ? weightFactor : 1;
                    for (let t = 0; t < times; t++) weighted.push(p);
                }
                
                const pool = weighted.length > 0 ? weighted : arr.slice();
                fisherYatesShuffle(pool);
                
                for (let n = 0; n < bq.quota; n++) {
                    if (pool.length === 0) break;
                    selected.push(pool[n % pool.length]);
                }
            }

            if (selected.length < config.particleCount) {
                const global = [];
                for (let p of points) {
                    const times = (p.brightness > 0.8) ? weightFactor : 1;
                    for (let t = 0; t < times; t++) global.push(p);
                }
                fisherYatesShuffle(global);
                
                let i = 0;
                while (selected.length < config.particleCount && global.length > 0) {
                    selected.push(global[i % global.length]);
                    i++;
                }
            }

            if (selected.length > config.particleCount) {
                selected.length = config.particleCount;
            }

            fisherYatesShuffle(selected);

            const extraJitter = 0.02;
            for (let i = 0; i < config.particleCount; i++) {
                const point = selected[i];
                positionArray[i * 4] = point.x + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 1] = point.y + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 2] = point.z + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 3] = 1.0;

                colorArray[i * 4] = point.r;
                colorArray[i * 4 + 1] = point.g;
                colorArray[i * 4 + 2] = point.b;
                colorArray[i * 4 + 3] = 1.0;

                sizeArray[i * 4] = point.size;
            }
        } else {
            const indices = Array.from({length: points.length}, (_, i) => i);
            fisherYatesShuffle(indices);

            for (let i = 0; i < config.particleCount; i++) {
                const pointIndex = indices[i % points.length];
                const point = points[pointIndex];
                const extraJitter = (i >= points.length) ? 0.1 : 0;

                positionArray[i * 4] = point.x + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 1] = point.y + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 2] = point.z + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 3] = 1.0;

                colorArray[i * 4] = point.r;
                colorArray[i * 4 + 1] = point.g;
                colorArray[i * 4 + 2] = point.b;
                colorArray[i * 4 + 3] = 1.0;

                sizeArray[i * 4] = point.size;
            }
        }
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
    processLogoData(matrixData, 'matrix');
    processLogoData(deltaData, 'delta');
    
    if (!gpgpu.matrixPositionTexture || !gpgpu.deltaPositionTexture) {
        console.error("Failed to create logo textures");
        return;
    }
    
    // Set initial positions
    gpgpu.simulationUniforms.originalPositions.value = gpgpu.matrixPositionTexture;
    
    // Copy to render targets
    copyTextureToRenderTarget(gpgpu.matrixPositionTexture, gpgpu.positionTargets[0]);
    copyTextureToRenderTarget(gpgpu.matrixPositionTexture, gpgpu.positionTargets[1]);
    
    // Initialize velocities with staggered lifecycle (only for idle state appearance)
    const size = config.textureSize;
    const velInitArray = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = y * size + x;
            const idx = i * 4;
            velInitArray[idx] = 0.0;
            velInitArray[idx + 1] = 0.0;
            velInitArray[idx + 2] = 0.0;
            // Staggered respawn delays for natural appearance in idle state
            velInitArray[idx + 3] = - (Math.random() * config.respawnDelayMax * 0.5);
        }
    }
    const velInitTex = createDataTexture(size, velInitArray);
    copyTextureToRenderTarget(velInitTex, gpgpu.velocityTargets[0]);
    copyTextureToRenderTarget(velInitTex, gpgpu.velocityTargets[1]);
    
    // Set render uniforms
    gpgpu.renderUniforms.positions.value = gpgpu.positionTargets[0].texture;
    gpgpu.renderUniforms.velocities.value = gpgpu.velocityTargets[0].texture; // For lifecycle
    gpgpu.renderUniforms.startColors.value = gpgpu.matrixColorTexture;
    gpgpu.renderUniforms.targetColors.value = gpgpu.matrixColorTexture;
    gpgpu.renderUniforms.sizes.value = gpgpu.matrixSizeTexture;
    gpgpu.renderUniforms.colorMix.value = 0.0;
    gpgpu.renderUniforms.isIdle.value = true;
    gpgpu.renderUniforms.isMorphing.value = false;
}

// Mouse interaction
const mouse = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let mouseWorldPos = new THREE.Vector3(-1000, -1000, -1000);

window.addEventListener('mousemove', (event) => {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const intersection = new THREE.Vector3();
    
    if (raycaster.ray.intersectPlane(plane, intersection)) {
        mouseWorldPos.copy(intersection);
    } else {
        mouseWorldPos.set(-1000, -1000, -1000);
    }
});

window.addEventListener('touchmove', (event) => {
    event.preventDefault();
    if (event.touches.length > 0) {
        const touch = event.touches[0];
        mouse.x = (touch.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(touch.clientY / window.innerHeight) * 2 + 1;
        
        raycaster.setFromCamera(mouse, camera);
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const intersection = new THREE.Vector3();
        
        if (raycaster.ray.intersectPlane(plane, intersection)) {
            mouseWorldPos.copy(intersection);
        }
    }
});

window.addEventListener('click', () => {
    if (isMorphing) return;

    // Reset camera to original position before starting new morph
    camera.position.z = originalCameraZ;
    
    isIdle = false;
    isMorphing = true;
    
    if (isFlocking) {
        isExploding = true;
        explosionStartTime = performance.now();
    }

    gpgpu.simulationUniforms.isIdle.value = false;
    gpgpu.simulationUniforms.isMorphing.value = true;
    gpgpu.simulationUniforms.isExploding.value = isExploding;
    
    // Update render uniforms
    gpgpu.renderUniforms.isIdle.value = false;
    gpgpu.renderUniforms.isMorphing.value = true;

    const previousLogo = currentLogo;
    currentLogo = currentLogo === 'matrix' ? 'delta' : 'matrix';
    gpgpu.simulationUniforms.morphProgress.value = 0;

    gpgpu.simulationUniforms.targetPositions.value =
        currentLogo === 'matrix' ? gpgpu.matrixPositionTexture : gpgpu.deltaPositionTexture;

    gpgpu.renderUniforms.colorStartTime.value = gpgpu.simulationUniforms.time.value;

    gpgpu.renderUniforms.startColors.value =
        previousLogo === 'matrix' ? gpgpu.matrixColorTexture : gpgpu.deltaColorTexture;

    gpgpu.renderUniforms.targetColors.value =
        currentLogo === 'matrix' ? gpgpu.matrixColorTexture : gpgpu.deltaColorTexture;

    gpgpu.renderUniforms.colorMix.value = 0;

    gpgpu.renderUniforms.sizes.value =
        currentLogo === 'matrix' ? gpgpu.matrixSizeTexture : gpgpu.deltaSizeTexture;

    morphStartTime = performance.now();
    flockingStartTime = performance.now();
    flockingPhase = "flocking";

    const toggleLogoButton = document.getElementById('toggleLogo');
    if (toggleLogoButton) {
        toggleLogoButton.textContent = `Switch to ${currentLogo === 'matrix' ? 'Delta' : 'Matrix'} Logo`;
    }
});

// UI event handlers
document.getElementById('toggleLogo').addEventListener('click', () => {
    window.dispatchEvent(new Event('click'));
});

document.getElementById('toggleFlocking').addEventListener('click', function() {
    isFlocking = !isFlocking;
    gpgpu.simulationUniforms.isFlocking.value = isFlocking;
    this.textContent = isFlocking ? 'Disable Flocking' : 'Enable Flocking';
    
    // Update mouse radius based on state
    gpgpu.simulationUniforms.mouseRadius.value = isFlocking ? config.mouseRadiusFlocking : config.mouseRadiusIdle;
    
    if (isFlocking) {
        flockingStartTime = performance.now();
        flockingPhase = "flocking";
    } else {
        flockingPhase = "idle";
        gpgpu.simulationUniforms.returnForceStrength.value = 0.0;
        
        if (isMorphing) {
            gpgpu.simulationUniforms.originalPositions.value = 
                currentLogo === 'matrix' ? gpgpu.matrixPositionTexture : gpgpu.deltaPositionTexture;
        }
    }
});

// Animation loop
const clock = new THREE.Clock();
let currentPositionTarget = 0;
let currentVelocityTarget = 0;

function animate() {
    requestAnimationFrame(animate);

    const deltaTime = clock.getDelta();
    const currentTime = performance.now();

    // Update uniforms
    gpgpu.simulationUniforms.deltaTime.value = deltaTime;
    gpgpu.simulationUniforms.time.value += deltaTime;
    gpgpu.renderUniforms.time.value = gpgpu.simulationUniforms.time.value;
    
    // Update render state uniforms
    gpgpu.renderUniforms.isIdle.value = isIdle;
    gpgpu.renderUniforms.isMorphing.value = isMorphing;

    // Update mouse radius based on state
    const isPureIdle = isIdle && !isMorphing;
    if (isPureIdle) {
        gpgpu.simulationUniforms.mouseRadius.value = config.mouseRadiusIdle;
        gpgpu.simulationUniforms.mousePosition.value.copy(mouseWorldPos);
    } else if (isFlocking && isMorphing) {
        gpgpu.simulationUniforms.mouseRadius.value = config.predatorRadius;
        gpgpu.simulationUniforms.mousePosition.value.copy(mouseWorldPos);
    } else {
        gpgpu.simulationUniforms.mousePosition.value.set(-1000, -1000, -1000);
    }

    // CAMERA BEHAVIOR - No incremental zoom
    if (isExploding) {
        const explosionElapsed = (currentTime - explosionStartTime) / 1000;
        gpgpu.simulationUniforms.explosionTime.value = explosionElapsed;
        
        if (explosionElapsed < config.explosionDuration) {
            // Smooth camera fly-in
            const flyProgress = explosionElapsed / config.explosionDuration;
            const easeOut = 1.0 - Math.pow(1.0 - flyProgress, 3.0);
            camera.position.z = originalCameraZ - (easeOut * config.cameraFlyThroughDistance);
        } else {
            // Smooth camera return during flocking transition
            const returnStart = config.explosionDuration;
            const returnDuration = 2.0; // Longer return for smoother transition
            const returnElapsed = explosionElapsed - returnStart;
            
            if (returnElapsed < returnDuration) {
                const returnProgress = returnElapsed / returnDuration;
                const easeReturn = returnProgress * returnProgress * (3.0 - 2.0 * returnProgress);
                camera.position.z = originalCameraZ - ((1.0 - easeReturn) * config.cameraFlyThroughDistance);
            } else {
                // Ensure camera is exactly at original position
                camera.position.z = originalCameraZ;
                isExploding = false;
                gpgpu.simulationUniforms.isExploding.value = false;
            }
        }
    } else {
        // Always ensure camera returns to original position
        camera.position.z += (originalCameraZ - camera.position.z) * 0.1;
        if (Math.abs(camera.position.z - originalCameraZ) < 0.1) {
            camera.position.z = originalCameraZ;
        }
    }

    // FLOCKING PHASE TRANSITIONS
    if (isFlocking && flockingPhase === "flocking") {
        const elapsed = (currentTime - flockingStartTime) / 1000;
        
        if (elapsed < FLOCKING_DURATION - 2.0) {
            // Free flocking phase - no return force
            gpgpu.simulationUniforms.returnForceStrength.value = 0.0;
        } else if (elapsed < FLOCKING_DURATION) {
            // Gradual start of return force
            const t = (elapsed - (FLOCKING_DURATION - 2.0)) / 2.0;
            const easedT = t * t * (3.0 - 2.0 * t) * 0.5;
            gpgpu.simulationUniforms.returnForceStrength.value = easedT;
        } else if (elapsed < TOTAL_FLOCKING_TIME) {
            // Main transition phase
            const t = (elapsed - FLOCKING_DURATION) / TRANSITION_DURATION;
            const easedT = t * t * (3.0 - 2.0 * t);
            gpgpu.simulationUniforms.returnForceStrength.value = easedT;
        } else {
            // Settled phase
            gpgpu.simulationUniforms.returnForceStrength.value = 1.0;
            flockingPhase = "settled";
        }
    }

    // Color mixing
    if (isMorphing && !isFlocking) {
        const elapsed = (currentTime - morphStartTime) / 1000;
        const cutoff = Math.max(0.1, TRANSITION_DURATION - 0.5);
        const t = Math.min(elapsed / cutoff, 1.0);
        const easedT = t * t * (3.0 - 2.0 * t);
        gpgpu.renderUniforms.colorMix.value = easedT;
    } else if (isMorphing && isFlocking) {
        const elapsed = (currentTime - flockingStartTime) / 1000;
        const cutoff = Math.max(0.1, TOTAL_FLOCKING_TIME - 0.5);
        const t = Math.min(elapsed / cutoff, 1.0);
        const easedT = t * t * (3.0 - 2.0 * t);
        gpgpu.renderUniforms.colorMix.value = easedT;
    } else if (flockingPhase === "settled" || (!isMorphing && !isIdle)) {
        gpgpu.renderUniforms.colorMix.value = 1.0;
    }

    // Ping-pong simulation
    const nextPositionTarget = 1 - currentPositionTarget;
    const nextVelocityTarget = 1 - currentVelocityTarget;

    // Velocity update
    gpgpu.simulationUniforms.positions.value = gpgpu.positionTargets[currentPositionTarget].texture;
    gpgpu.simulationUniforms.velocities.value = gpgpu.velocityTargets[currentVelocityTarget].texture;
    gpgpu.simulationMesh.material = gpgpu.velocityMaterial;
    renderer.setRenderTarget(gpgpu.velocityTargets[nextVelocityTarget]);
    renderer.render(gpgpu.simulationScene, gpgpu.simulationCamera);

    // Position update
    gpgpu.simulationUniforms.positions.value = gpgpu.positionTargets[currentPositionTarget].texture;
    gpgpu.simulationUniforms.velocities.value = gpgpu.velocityTargets[nextVelocityTarget].texture;
    gpgpu.simulationMesh.material = gpgpu.positionMaterial;
    renderer.setRenderTarget(gpgpu.positionTargets[nextPositionTarget]);
    renderer.render(gpgpu.simulationScene, gpgpu.simulationCamera);

    renderer.setRenderTarget(null);

    // Update render uniforms
    gpgpu.renderUniforms.positions.value = gpgpu.positionTargets[nextPositionTarget].texture;
    gpgpu.renderUniforms.velocities.value = gpgpu.velocityTargets[nextVelocityTarget].texture;

    // Render particles
    renderer.render(scene, camera);

    // Swap buffers
    currentPositionTarget = nextPositionTarget;
    currentVelocityTarget = nextVelocityTarget;

    // Morph completion
    if (isMorphing) {
        gpgpu.simulationUniforms.morphProgress.value += deltaTime;

        if (gpgpu.simulationUniforms.morphProgress.value >= 3.0) {
            isMorphing = false;
            isIdle = true;

            gpgpu.simulationUniforms.isMorphing.value = false;
            gpgpu.simulationUniforms.isIdle.value = true;
            gpgpu.renderUniforms.isMorphing.value = false;
            gpgpu.renderUniforms.isIdle.value = true;

            gpgpu.simulationUniforms.originalPositions.value =
                currentLogo === 'matrix' ? gpgpu.matrixPositionTexture : gpgpu.deltaPositionTexture;

            gpgpu.simulationUniforms.targetPositions.value = null;
            gpgpu.renderUniforms.colorMix.value = 1.0;
            
            // Final camera reset
            if (isExploding) {
                isExploding = false;
                gpgpu.simulationUniforms.isExploding.value = false;
            }
            camera.position.z = originalCameraZ;
        }
    }
    
    if (flockingPhase === "settled") {
        gpgpu.renderUniforms.colorMix.value = 1.0;
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