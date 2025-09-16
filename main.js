// Configuration (enhanced for better visual quality)
const config = {
    particleSize: 1.2,  // Increased for better visibility
    mouseRadius: 60,
    mouseStrength: 250,
    morphSpeed: 0.04,   // Slightly slower for smoother transition

    // Enhanced delta scale for better visual appearance
    deltaLogoScale: 0.06,
    deltaColorBoost: 1.1,
    deltaZSpread: 0.3,
    deltaYOffset: 1.8,

    // Enhanced matrix values
    matrixLogoScale: 0.18,
    matrixYOffset: 0,

    cameraZoomFactor: 1.5,
    textureSize: 256,

    // Enhanced flocking parameters for smoother behavior
    separationDistance: 15.0,
    alignmentDistance: 25.0,
    cohesionDistance: 30.0,
    freedomFactor: 0.85,
    bounds: 120,
    speedLimit: 8.0,
    flockingIntensity: 0.7,
    neighborSampleCount: 9  // 3x3 grid for sampling
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
scene.fog = new THREE.Fog(0xffffff, 70, 120); // Add subtle fog for depth

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio)); // Limit pixel ratio for performance
document.body.appendChild(renderer.domElement);

// Add subtle lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.4);
directionalLight.position.set(1, 1, 1);
scene.add(directionalLight);

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
        flockingIntensity: { value: config.flockingIntensity },
        time: { value: 0 },
        neighborSampleCount: { value: config.neighborSampleCount }
    },
    renderUniforms: {
        positions: { value: null },
        colors: { value: null },
        sizes: { value: null },
        particleSize: { value: config.particleSize },
        fogColor: { value: new THREE.Color(0xffffff) },
        fogNear: { value: 70 },
        fogFar: { value: 120 }
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
    gpgpu.simulationUniforms.isIdle.value = true;
    gpgpu.simulationUniforms.isFlocking.value = false;
    gpgpu.simulationUniforms.separationDistance.value = config.separationDistance;
    gpgpu.simulationUniforms.alignmentDistance.value = config.alignmentDistance;
    gpgpu.simulationUniforms.cohesionDistance.value = config.cohesionDistance;
    gpgpu.simulationUniforms.freedomFactor.value = config.freedomFactor;
    gpgpu.simulationUniforms.bounds.value = config.bounds;
    gpgpu.simulationUniforms.speedLimit.value = config.speedLimit;
    gpgpu.simulationUniforms.flockingIntensity.value = config.flockingIntensity;
    gpgpu.simulationUniforms.neighborSampleCount.value = config.neighborSampleCount;
    
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
        blending: THREE.NormalBlending,
        fog: true
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

// Enhanced Velocity shader with improved flocking behavior
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
    uniform float flockingIntensity;
    uniform float time;
    uniform float neighborSampleCount;

    varying vec2 vUv;

    const float PI = 3.141592653589793;
    const float PI_2 = PI * 2.0;
    const float textureSize = ${config.textureSize.toFixed(1)};

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

        // Morph easing (staggered with smooth curve)
        float t = clamp(morphProgress / 3.0, 0.0, 1.0);
        float delay = fract(sin(dot(vUv, vec2(91.345, 47.853))) * 43758.5453) * 0.7;
        float particleT = clamp((t - delay) / (1.0 - delay), 0.0, 1.0);
        float easedT = smoothstep(0.0, 1.0, particleT);

        // Attraction toward target (strong when morphing), or gentle settle to home when idle
        vec3 desire = (isMorphing ? targetPos : homePos) - pos;
        float attractStrength = isMorphing ? (0.8 * easedT + 0.2) : 0.08;
        vel += desire * attractStrength * deltaTime * 10.0;

        // Mouse repulsion only when not morphing and not idle-locked
        if (!isMorphing && !isIdle) {
            float distToMouse = distance(pos, mousePosition);
            if (distToMouse < mouseRadius) {
                vec3 dir = normalize(pos - mousePosition);
                float force = (1.0 - smoothstep(0.0, mouseRadius, distToMouse)) * mouseStrength;
                vel += dir * force * deltaTime;
            }
        }

        // Flocking behavior during morph
        if (isFlocking && isMorphing && particleT > 0.1 && particleT < 0.9) {
            float zoneRadius = separationDistance + alignmentDistance + cohesionDistance;
            float separationThresh = separationDistance / zoneRadius;
            float alignmentThresh = ( separationDistance + alignmentDistance ) / zoneRadius;
            float zoneRadiusSquared = zoneRadius * zoneRadius;

            // Apply bounds with soft edge
            float distToCenter = length(pos);
            if (distToCenter > bounds * 0.8) {
                float edgeFactor = smoothstep(bounds * 0.8, bounds, distToCenter);
                vel -= normalize(pos) * deltaTime * 8.0 * edgeFactor;
            }

            // Sample neighboring particles in a grid pattern
            float sampleCount = floor(sqrt(neighborSampleCount));
            float sampleStep = 1.0 / sampleCount;
            
            vec3 separationForce = vec3(0.0);
            vec3 alignmentForce = vec3(0.0);
            vec3 cohesionForce = vec3(0.0);
            int separationCount = 0;
            int alignmentCount = 0;
            int cohesionCount = 0;
            
            for (float y = 0.0; y < sampleCount; y += 1.0) {
                for (float x = 0.0; x < sampleCount; x += 1.0) {
                    // Skip center sample (self)
                    if (x == floor(sampleCount/2.0) && y == floor(sampleCount/2.0)) continue;
                    
                    vec2 ref = vUv + vec2((x - sampleCount/2.0) * sampleStep / textureSize, 
                                         (y - sampleCount/2.0) * sampleStep / textureSize);
                    
                    // Skip out of bounds
                    if (ref.x < 0.0 || ref.x > 1.0 || ref.y < 0.0 || ref.y > 1.0) continue;
                    
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
                        separationForce -= normalize(dir) * (1.0 - percent/separationThresh);
                        separationCount++;
                    } 
                    // Alignment
                    else if (percent < alignmentThresh) {
                        alignmentForce += normalize(otherVel);
                        alignmentCount++;
                    } 
                    // Cohesion
                    else {
                        cohesionForce += normalize(dir);
                        cohesionCount++;
                    }
                }
            }
            
            // Apply flocking forces with intensity control
            if (separationCount > 0) {
                vel += separationForce * deltaTime * 5.0 * flockingIntensity;
            }
            if (alignmentCount > 0) {
                vel += (alignmentForce / float(alignmentCount)) * deltaTime * 3.0 * flockingIntensity;
            }
            if (cohesionCount > 0) {
                vel += (cohesionForce / float(cohesionCount)) * deltaTime * 2.0 * flockingIntensity;
            }

            // Speed limit with smooth transition
            float currentSpeed = length(vel);
            if (currentSpeed > speedLimit) {
                vel = normalize(vel) * mix(currentSpeed, speedLimit, 0.2);
            }
        }

        // Damping with variable rate based on state
        float damping = isMorphing ? 0.92 : 0.96;
        vel *= damping;

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
    uniform float fogNear;
    uniform float fogFar;
    uniform vec3 fogColor;

    varying vec4 vColor;
    varying float vSize;
    varying float vFogDepth;

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
        vFogDepth = -mvPosition.z;
        gl_PointSize = vSize * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const renderFragmentShader = `
    precision highp float;

    uniform float fogNear;
    uniform float fogFar;
    uniform vec3 fogColor;

    varying vec4 vColor;
    varying float vSize;
    varying float vFogDepth;

    void main() {
        vec4 color = vColor;
        
        // Circular point with soft edge
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);
        float alpha = 1.0 - smoothstep(0.35, 0.5, dist);
        
        if (alpha < 0.01) discard;
        
        color.a *= alpha;
        
        // Apply fog
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        color.rgb = mix(color.rgb, fogColor, fogFactor);
        
        gl_FragColor = color;
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
            context.drawImage(img, 0, 0, canvas.width, canvas.height);

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

    // Sample every pixel for better logo definition
    for (let y = 0; y < data.height; y += 1) {
        for (let x = 0; x < data.width; x += 1) {
            const index = (y * data.width + x) * 4;
            const r = dataArray[index];
            const g = dataArray[index + 1];
            const b = dataArray[index + 2];
            const a = dataArray[index + 3];

            // Skip transparent/near-white pixels with a more precise threshold
            if (a <= 20 || (r > 240 && g > 240 && b > 240)) continue;

            let normalizedR = r / 255;
            let normalizedG = g / 255;
            let normalizedB = b / 255;

            if (logoType === 'delta') {
                normalizedR = Math.min(normalizedR * config.deltaColorBoost, 1.0);
                normalizedG = Math.min(normalizedG * config.deltaColorBoost, 1.0);
                normalizedB = Math.min(normalizedB * config.deltaColorBoost, 1.0);
            }

            // Use scale directly with reduced jitter for cleaner logo appearance
            const jitter = 0.02; // reduced jitter for crisper logo
            const px = ((x - data.width / 2) + (Math.random() - 0.5) * jitter) * scale;
            const py = ((data.height / 2 - y) + (Math.random() - 0.5) * jitter) * scale
                       + (logoType === 'delta' ? config.deltaYOffset : config.matrixYOffset);

            // Add slight depth variation for more interesting visuals
            const pz = (Math.random() - 0.5) * zSpread;

            points.push({
                x: px,
                y: py,
                z: pz,
                r: normalizedR,
                g: normalizedG,
                b: normalizedB,
                size: logoType === 'matrix'
                    ? 0.9 + (1 - (normalizedR + normalizedG + normalizedB) / 3) * 0.3
                    : 1.1
            });
        }
    }

    const size = config.textureSize;
    const positionArray = new Float32Array(size * size * 4);
    const colorArray = new Float32Array(size * size * 4);
    const sizeArray = new Float32Array(size * size * 4);

    // Fill the texture with particles, repeating if needed
    for (let i = 0; i < config.particleCount; i++) {
        const pointIndex = i % points.length;
        const point = points[pointIndex];

        positionArray[i * 4] = point.x;
        positionArray[i * 4 + 1] = point.y;
        positionArray[i * 4 + 2] = point.z;
        positionArray[i * 4 + 3] = 1.0;

        colorArray[i * 4] = point.r;
        colorArray[i * 4 + 1] = point.g;
        colorArray[i * 4 + 2] = point.b;
        colorArray[i * 4 + 3] = 1.0;

        sizeArray[i * 4] = point.size;
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
    
    // Set simulation uniforms to use render target textures
    gpgpu.simulationUniforms.positions.value = gpgpu.positionTargets[0].texture;
    gpgpu.simulationUniforms.velocities.value = gpgpu.velocityTargets[0].texture;
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

    const deltaTime = Math.min(clock.getDelta(), 0.033); // Cap at 30fps for consistency

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
