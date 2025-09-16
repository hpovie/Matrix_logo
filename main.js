// Configuration
const config = {
    particleSize: 1.5,
    mouseRadius: 60,
    mouseStrength: 300,
    morphSpeed: 0.03,
    flockingDuration: 10.0, // 10 seconds total flocking time
    colorTransitionStart: 0.2, // Start color transition at 20% of flocking
    colorTransitionEnd: 0.8,   // Complete color transition at 80% of flocking

    // Logo scaling
    matrixLogoScale: 0.18,
    deltaLogoScale: 0.06,
    deltaYOffset: 1.8,
    deltaZSpread: 0.3,

    // Flocking parameters
    separationDistance: 15.0,
    alignmentDistance: 25.0,
    cohesionDistance: 30.0,
    freedomFactor: 0.85,
    bounds: 120,
    speedLimit: 8.0,
    flockingIntensity: 0.7,
    curlNoiseIntensity: 0.5,
    curlNoiseScale: 0.1,
    respawnRate: 0.01, // Probability of respawn per frame

    // Technical
    textureSize: 256,
    cameraZoomFactor: 1.5
};
config.particleCount = config.textureSize * config.textureSize;

// State
let currentLogo = 'matrix';
let isMorphing = false;
let isIdle = true;
let isFlocking = false;
let flockingProgress = 0;
let flockingStartTime = 0;

// Three.js setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000); // Black background for better contrast

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
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
        flockingProgress: { value: 0 },
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
        curlNoiseIntensity: { value: config.curlNoiseIntensity },
        curlNoiseScale: { value: config.curlNoiseScale },
        respawnRate: { value: config.respawnRate },
        time: { value: 0 },
        colorTransitionStart: { value: config.colorTransitionStart },
        colorTransitionEnd: { value: config.colorTransitionEnd }
    },
    renderUniforms: {
        positions: { value: null },
        colors: { value: null },
        targetColors: { value: null },
        sizes: { value: null },
        particleSize: { value: config.particleSize },
        colorBlend: { value: 0 }
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
    gpgpu.simulationUniforms.flockingProgress.value = 0;
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
    gpgpu.simulationUniforms.curlNoiseIntensity.value = config.curlNoiseIntensity;
    gpgpu.simulationUniforms.curlNoiseScale.value = config.curlNoiseScale;
    gpgpu.simulationUniforms.respawnRate.value = config.respawnRate;
    gpgpu.simulationUniforms.colorTransitionStart.value = config.colorTransitionStart;
    gpgpu.simulationUniforms.colorTransitionEnd.value = config.colorTransitionEnd;
    
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
        blending: THREE.AdditiveBlending,
        depthWrite: false
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

// Shader code with enhanced flocking, color morphing, and particle lifecycle
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

    uniform vec3  mousePosition;
    uniform float mouseRadius;
    uniform float mouseStrength;

    uniform float morphProgress;
    uniform float flockingProgress;
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
    uniform float curlNoiseIntensity;
    uniform float curlNoiseScale;
    uniform float respawnRate;
    uniform float time;
    uniform float colorTransitionStart;
    uniform float colorTransitionEnd;

    varying vec2 vUv;

    const float PI = 3.141592653589793;
    const float PI_2 = PI * 2.0;
    const float textureSize = ${config.textureSize.toFixed(1)};

    // Classic Perlin 3D Noise by Stefan Gustavson
    vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
    vec3 fade(vec3 t) {return t*t*t*(t*(t*6.0-15.0)+10.0);}

    float cnoise(vec3 P){
        vec3 Pi0 = floor(P); // Integer part for indexing
        vec3 Pi1 = Pi0 + vec3(1.0); // Integer part + 1
        Pi0 = mod(Pi0, 289.0);
        Pi1 = mod(Pi1, 289.0);
        vec3 Pf0 = fract(P); // Fractional part for interpolation
        vec3 Pf1 = Pf0 - vec3(1.0); // Fractional part - 1.0
        vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
        vec4 iy = vec4(Pi0.yy, Pi1.yy);
        vec4 iz0 = Pi0.zzzz;
        vec4 iz1 = Pi1.zzzz;

        vec4 ixy = permute(permute(ix) + iy);
        vec4 ixy0 = permute(ixy + iz0);
        vec4 ixy1 = permute(ixy + iz1);

        vec4 gx0 = ixy0 / 7.0;
        vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5;
        gx0 = fract(gx0);
        vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
        vec4 sz0 = step(gz0, vec4(0.0));
        gx0 -= sz0 * (step(0.0, gx0) - 0.5);
        gy0 -= sz0 * (step(0.0, gy0) - 0.5);

        vec4 gx1 = ixy1 / 7.0;
        vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5;
        gx1 = fract(gx1);
        vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
        vec4 sz1 = step(gz1, vec4(0.0));
        gx1 -= sz1 * (step(0.0, gx1) - 0.5);
        gy1 -= sz1 * (step(0.0, gy1) - 0.5);

        vec3 g000 = vec3(gx0.x,gy0.x,gz0.x);
        vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
        vec3 g010 = vec3(gx0.z,gy0.z,gz0.z);
        vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
        vec3 g001 = vec3(gx1.x,gy1.x,gz1.x);
        vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
        vec3 g011 = vec3(gx1.z,gy1.z,gz1.z);
        vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);

        vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
        g000 *= norm0.x;
        g010 *= norm0.y;
        g100 *= norm0.z;
        g110 *= norm0.w;
        vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
        g001 *= norm1.x;
        g011 *= norm1.y;
        g101 *= norm1.z;
        g111 *= norm1.w;

        float n000 = dot(g000, Pf0);
        float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
        float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
        float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
        float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
        float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
        float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
        float n111 = dot(g111, Pf1);

        vec3 fade_xyz = fade(Pf0);
        vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
        vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
        float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
        return 2.2 * n_xyz;
    }

    // Curl noise function
    vec3 curlNoise(vec3 p) {
        const float e = 0.1;
        vec3 dx = vec3(e, 0.0, 0.0);
        vec3 dy = vec3(0.0, e, 0.0);
        vec3 dz = vec3(0.0, 0.0, e);

        float n1 = cnoise(p + dy);
        float n2 = cnoise(p - dy);
        float n3 = cnoise(p + dx);
        float n4 = cnoise(p - dx);
        float n5 = cnoise(p + dz);
        float n6 = cnoise(p - dz);

        float x = (n2 - n1) - (n6 - n5);
        float y = (n4 - n3) - (n6 - n5);
        float z = (n4 - n3) - (n2 - n1);

        return vec3(x, y, z) / e;
    }

    float rand(vec2 co) {
        return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453);
    }

    void main() {
        vec3 pos = texture2D(positions, vUv).xyz;
        vec4 vel4 = texture2D(velocities, vUv);
        vec3 vel = vel4.xyz;
        float life = vel4.w;

        vec3 homePos = texture2D(originalPositions, vUv).xyz;
        vec3 targetPos = isMorphing ? texture2D(targetPositions, vUv).xyz : homePos;

        // Determine if we should switch to target positions (halfway through flocking)
        bool useTargetPositions = isMorphing && flockingProgress > 0.5;
        vec3 desiredPos = useTargetPositions ? targetPos : homePos;

        // Calculate progress with easing
        float progress = isMorphing ? flockingProgress : 0.0;
        float easeProgress = progress < 0.5 ? 2.0 * progress * progress : 1.0 - pow(-2.0 * progress + 2.0, 2.0) / 2.0;

        // Apply curl noise for organic motion when flocking
        if (isFlocking) {
            vec3 noise = curlNoise(pos * curlNoiseScale + time) * curlNoiseIntensity;
            vel += noise * deltaTime;
        }

        // Attraction toward target position
        vec3 toTarget = desiredPos - pos;
        float distToTarget = length(toTarget);
        
        if (distToTarget > 0.001) {
            float attractStrength = isMorphing ? 
                mix(0.1, 0.8, easeProgress) : 
                0.05;
                
            vel += normalize(toTarget) * attractStrength * deltaTime * 10.0;
        }

        // Mouse repulsion
        if (!isMorphing && isIdle) {
            float distToMouse = distance(pos, mousePosition);
            if (distToMouse < mouseRadius) {
                vec3 dir = normalize(pos - mousePosition);
                float force = (1.0 - smoothstep(0.0, mouseRadius, distToMouse)) * mouseStrength;
                vel += dir * force * deltaTime;
            }
        }

        // Flocking behavior
        if (isFlocking) {
            float zoneRadius = separationDistance + alignmentDistance + cohesionDistance;
            float separationThresh = separationDistance / zoneRadius;
            float alignmentThresh = (separationDistance + alignmentDistance) / zoneRadius;
            float zoneRadiusSquared = zoneRadius * zoneRadius;

            vec3 separationForce = vec3(0.0);
            vec3 alignmentForce = vec3(0.0);
            vec3 cohesionForce = vec3(0.0);
            int separationCount = 0;
            int alignmentCount = 0;
            int cohesionCount = 0;

            // Sample neighbors in a 3x3 grid
            for (float y = -1.0; y <= 1.0; y += 1.0) {
                for (float x = -1.0; x <= 1.0; x += 1.0) {
                    if (x == 0.0 && y == 0.0) continue; // Skip self
                    
                    vec2 ref = vUv + vec2(x / textureSize, y / textureSize);
                    
                    if (ref.x < 0.0 || ref.x > 1.0 || ref.y < 0.0 || ref.y > 1.0) continue;
                    
                    vec3 otherPos = texture2D(positions, ref).xyz;
                    vec3 otherVel = texture2D(velocities, ref).xyz;
                    
                    vec3 dir = otherPos - pos;
                    float dist = length(dir);
                    
                    if (dist < 0.001) continue;
                    
                    float distSquared = dist * dist;
                    
                    if (distSquared > zoneRadiusSquared) continue;
                    
                    float percent = distSquared / zoneRadiusSquared;
                    
                    if (percent < separationThresh) {
                        separationForce -= normalize(dir) * (1.0 - percent / separationThresh);
                        separationCount++;
                    } else if (percent < alignmentThresh) {
                        alignmentForce += normalize(otherVel);
                        alignmentCount++;
                    } else {
                        cohesionForce += normalize(dir);
                        cohesionCount++;
                    }
                }
            }
            
            // Apply flocking forces
            if (separationCount > 0) {
                vel += separationForce * deltaTime * 6.0 * flockingIntensity;
            }
            if (alignmentCount > 0) {
                vel += (alignmentForce / float(alignmentCount)) * deltaTime * 4.0 * flockingIntensity;
            }
            if (cohesionCount > 0) {
                vel += (cohesionForce / float(cohesionCount)) * deltaTime * 3.0 * flockingIntensity;
            }
        }

        // Apply bounds with soft edge
        float distToCenter = length(pos);
        if (distToCenter > bounds * 0.8) {
            float edgeFactor = smoothstep(bounds * 0.8, bounds, distToCenter);
            vel -= normalize(pos) * deltaTime * 8.0 * edgeFactor;
        }

        // Speed limiting
        float currentSpeed = length(vel);
        if (currentSpeed > speedLimit) {
            vel = normalize(vel) * mix(currentSpeed, speedLimit, 0.2);
        }

        // Damping
        vel *= 0.94;

        // Particle lifecycle - respawn if dead or based on probability
        if (life <= 0.0 || (isFlocking && rand(vUv + time) < respawnRate * deltaTime)) {
            // Reset to home position with some randomness
            pos = homePos + (vec3(rand(vUv), rand(vUv + 0.5), rand(vUv + 0.25)) - 0.5) * 2.0;
            vel = vec3(0.0);
            life = 1.0; // Full life
        } else if (isFlocking) {
            // Gradually decrease life during flocking
            life -= deltaTime * 0.05;
        }

        gl_FragColor = vec4(vel, life);
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

        // Only update position if particle is alive
        if (life > 0.0) {
            pos += vel * deltaTime;
        }

        gl_FragColor = vec4(pos, life);
    }
`;

const renderVertexShader = `
    precision highp float;

    uniform sampler2D positions;
    uniform sampler2D colors;
    uniform sampler2D targetColors;
    uniform sampler2D sizes;
    uniform float particleSize;
    uniform float colorBlend;

    varying vec4 vColor;
    varying float vSize;
    varying float vLife;

    void main() {
        vec4 positionData = texture2D(positions, uv);
        vec3 pos = positionData.xyz;
        float life = positionData.w;
        
        vec4 originalColor = texture2D(colors, uv);
        vec4 targetColor = texture2D(targetColors, uv);
        
        // Blend between original and target colors based on progress
        vColor = mix(originalColor, targetColor, colorBlend);
        
        float sizeData = texture2D(sizes, uv).r;
        vSize = particleSize * sizeData;
        
        vLife = life;
        vColor.a = life; // Alpha based on life

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = vSize * (300.0 / -mvPosition.z) * (0.5 + 0.5 * life);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const renderFragmentShader = `
    precision highp float;

    varying vec4 vColor;
    varying float vSize;
    varying float vLife;

    void main() {
        vec4 color = vColor;
        
        // Circular point with soft edge and glow based on life
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);
        float alpha = 1.0 - smoothstep(0.3, 0.5, dist);
        
        // Add glow effect based on particle life
        float glow = smoothstep(0.0, 0.5, vLife) * 0.5;
        alpha += glow * (1.0 - smoothstep(0.0, 0.7, dist));
        
        if (alpha < 0.01) discard;
        
        color.a *= alpha;
        
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
    const zSpread = logoType === 'matrix' ? 0.1 : config.deltaZSpread;

    // Sample every pixel for better logo definition
    for (let y = 0; y < data.height; y += 1) {
        for (let x = 0; x < data.width; x += 1) {
            const index = (y * data.width + x) * 4;
            const r = dataArray[index];
            const g = dataArray[index + 1];
            const b = dataArray[index + 2];
            const a = dataArray[index + 3];

            // Skip transparent/near-white pixels
            if (a <= 20 || (r > 240 && g > 240 && b > 240)) continue;

            let normalizedR = r / 255;
            let normalizedG = g / 255;
            let normalizedB = b / 255;

            // Use scale directly with reduced jitter for cleaner logo appearance
            const jitter = 0.01;
            const px = ((x - data.width / 2) + (Math.random() - 0.5) * jitter) * scale;
            const py = ((data.height / 2 - y) + (Math.random() - 0.5) * jitter) * scale
                       + (logoType === 'delta' ? config.deltaYOffset : 0);

            // Add slight depth variation
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
        positionArray[i * 4 + 3] = 1.0; // Initial life

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
    gpgpu.renderUniforms.targetColors.value = gpgpu.deltaColorTexture;
    gpgpu.renderUniforms.sizes.value = gpgpu.matrixSizeTexture;
    gpgpu.renderUniforms.colorBlend.value = 0;
    
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

function startMorph() {
    // Prevent starting during morph
    if (isMorphing) return;

    // Begin morphing
    isIdle = false;
    isMorphing = true;
    isFlocking = true;
    flockingStartTime = performance.now() / 1000;
    flockingProgress = 0;

    gpgpu.simulationUniforms.isIdle.value = false;
    gpgpu.simulationUniforms.isMorphing.value = true;
    gpgpu.simulationUniforms.isFlocking.value = true;

    // Flip current logo
    currentLogo = currentLogo === 'matrix' ? 'delta' : 'matrix';

    // Reset morph progress
    gpgpu.simulationUniforms.morphProgress.value = 0;
    gpgpu.simulationUniforms.flockingProgress.value = 0;

    // Set target positions (destination of morph)
    gpgpu.simulationUniforms.targetPositions.value =
        currentLogo === 'matrix'
            ? gpgpu.matrixPositionTexture
            : gpgpu.deltaPositionTexture;

    // Update render textures (for color and size)
    if (currentLogo === 'matrix') {
        gpgpu.renderUniforms.colors.value = gpgpu.deltaColorTexture;
        gpgpu.renderUniforms.targetColors.value = gpgpu.matrixColorTexture;
        gpgpu.renderUniforms.sizes.value = gpgpu.deltaSizeTexture;
    } else {
        gpgpu.renderUniforms.colors.value = gpgpu.matrixColorTexture;
        gpgpu.renderUniforms.targetColors.value = gpgpu.deltaColorTexture;
        gpgpu.renderUniforms.sizes.value = gpgpu.matrixSizeTexture;
    }

    // Update button text
    document.getElementById('toggleLogo').textContent = 
        `Switch to ${currentLogo === 'matrix' ? 'Delta' : 'Matrix'} Logo`;

    // Disable mouse interaction during morph
    gpgpu.simulationUniforms.mousePosition.value.set(-1000, -1000, -1000);
}

window.addEventListener('click', startMorph);

// UI event handlers
document.getElementById('toggleLogo').addEventListener('click', startMorph);

document.getElementById('toggleFlocking').addEventListener('click', function() {
    isFlocking = !isFlocking;
    gpgpu.simulationUniforms.isFlocking.value = isFlocking;
    this.textContent = isFlocking ? 'Disable Flocking' : 'Enable Flocking';
});

// Auto-timer for morphing (every 15 seconds)
setInterval(() => {
    if (isIdle && !isMorphing) {
        startMorph();
    }
}, 15000);

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

    // Update flocking progress if morphing
    if (isMorphing) {
        const currentTime = performance.now() / 1000;
        flockingProgress = (currentTime - flockingStartTime) / config.flockingDuration;
        gpgpu.simulationUniforms.flockingProgress.value = flockingProgress;
        
        // Update color blend based on flocking progress
        const colorBlend = smoothstep(config.colorTransitionStart, config.colorTransitionEnd, flockingProgress);
        gpgpu.renderUniforms.colorBlend.value = colorBlend;
    }

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
    if (isMorphing && flockingProgress >= 1.0) {
        // Morph complete — lock into final logo
        isMorphing = false;
        isIdle = true;
        isFlocking = false;

        gpgpu.simulationUniforms.isMorphing.value = false;
        gpgpu.simulationUniforms.isIdle.value = true;
        gpgpu.simulationUniforms.isFlocking.value = false;

        // Now that morph is done, set new home position
        gpgpu.simulationUniforms.originalPositions.value =
            currentLogo === 'matrix'
                ? gpgpu.matrixPositionTexture
                : gpgpu.deltaPositionTexture;

        // Update render colors to match the new logo
        gpgpu.renderUniforms.colors.value =
            currentLogo === 'matrix'
                ? gpgpu.matrixColorTexture
                : gpgpu.deltaColorTexture;
                
        gpgpu.renderUniforms.sizes.value =
            currentLogo === 'matrix'
                ? gpgpu.matrixSizeTexture
                : gpgpu.deltaSizeTexture;
                
        gpgpu.renderUniforms.colorBlend.value = 0;

        // Clear target
        gpgpu.simulationUniforms.targetPositions.value = null;
    }
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Smoothstep function for easing
function smoothstep(edge0, edge1, x) {
    x = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return x * x * (3.0 - 2.0 * x);
}

function clamp(x, minVal, maxVal) {
    return min(max(x, minVal), maxVal);
}

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
