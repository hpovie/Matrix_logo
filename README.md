# Logo project

### Core vision

 

A **Three.js GPGPU particle system** where particles:
* Start in one logo shape (**Matrix logo**).
* On click (or timer), flock/morph into another logo (**Delta logo*).
* Move organically and fluidly.


### Colours

* Particles should initially match the **Matrix logo’s colours**.
* During morph, **gradually switch, at random**, to the Delta logo’s colours.
* Colour transition should only happen **while flocking**, not while static.

### Particle Behaviour

#### Initialization

* Particles start static in the Matrix logo positions and colours.


#### On Click (or trigger):

* Flocking begins (like the official Three.js birds demo).
* colour morphing starts only now.
* Halfway through flocking, target positions switch to the Delta logo.
* After approximately 10s, particles resettle into Delta logo organically.

#### Motion:

* Fluid, natural, boid style motion
* Stronger flocking force (avoid scatter or slow inward “black hole” effect). Z axis motion still to be added for depth
* Random swarming motion added for liveliness.
* Persistent flow/curl noise when idle as in the flow field example (but stable in logo shape). optional
* Mouse interaction: particles repel when cursor passes  

#### Lifecycle

* Particles can “die” and respawn back at their home positions. (to have a wispy dust effect with mouse repulsion instead on an elastic band effect)
* Ensures density and prevents empty patches.

#### Technical Constraints

* Use GPGPU shaders (ping-pong simulation with position/velocity textures).
* Maintain performance optimization (avoid CPU-heavy loops).
* Keep GPUComputationRenderer or GPU.js approach consistent.
* Ensure fragmentShaderVelocity applies both flocking and return-to-target forces.

### Compatibilty Matrix

| Operating System | Browser | supported |
| --- | --- | --- |
| Windows | Chrome/Edge | ✅ |
| macOS | Chrome/Edge | ✅ |
| Linux | Chrome  | ✅ |
| Hiram's crap laptop | Every browser | ❌ |