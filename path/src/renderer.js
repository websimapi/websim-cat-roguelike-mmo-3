// ... existing code ...

render(gameState, localPlayerId) {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    const sCtx = this.shadowCtx;
    
    // Clear
    ctx.clearRect(0, 0, width, height);

    if (!ASSETS.loaded) return;

    const sun = this.getSunState();

    // Camera follows local player
    let camX = CONFIG.GRID_W / 2;
    let camY = CONFIG.GRID_H / 2;

    if (gameState.players[localPlayerId]) {
        const p = gameState.players[localPlayerId];
        camX = p.x;
        camY = p.y;
    }

    const tileSize = CONFIG.TILE_SIZE * CONFIG.SCALE;
    const gateX = 11; // 11th grid tile (Center of 23)
    const gateY = Math.floor(CONFIG.GRID_H / 2);

    // Bucket Entities by Row for Depth Sorting
    const entitiesByRow = Array.from({ length: CONFIG.GRID_H }, () => []);

    // Add NPCs, Players, Projectiles
    gameState.npcs.forEach(npc => addToBucket('npc', npc));
    Object.values(gameState.players).forEach(p => addToBucket('player', p));
    gameState.projectiles.forEach(p => addToBucket('projectile', p));

    // 1. Draw ALL Floors First (Background Layer)
    // This ensures floor exists under walls as requested
    for (let y = 0; y < CONFIG.GRID_H; y++) {
        for (let x = 0; x < CONFIG.GRID_W; x++) {
            // Skip floor at Top Exit to show Void
            if (x === gateX && y === 0) continue;

            const pos = this.gridToScreen(x, y, camX, camY);
            // Relaxed culling so floors disappear later and reappear earlier
            if (
                pos.x < -tileSize * 2 ||
                pos.x > width + tileSize * 2 ||
                pos.y < -tileSize * 2 ||
                pos.y > height + tileSize * 2
            ) continue;
            
            // Draw grass texture repeated 4 times inside each grid tile (2x2 sub-tiles)
            const subSize = tileSize / 2;
            for (let oy = 0; oy < 2; oy++) {
                for (let ox = 0; ox < 2; ox++) {
                    ctx.drawImage(
                        ASSETS.floor,
                        pos.x + ox * subSize,
                        pos.y + oy * subSize,
                        subSize,
                        subSize
                    );
                }
            }
        }
    }

    // 2. SHADOW PASS
    // We draw all shadows onto a separate canvas (sCtx) using solid black
    // Then we draw that canvas onto the main canvas with a single alpha value
    sCtx.clearRect(0, 0, width, height);
    
    // Only draw shadows if there is light
    if (sun.intensity > 0.05) {
        sCtx.fillStyle = '#000000';
        
        // A. Wall Shadows
        for (let y = 0; y < CONFIG.GRID_H; y++) {
            for (let x = 0; x < CONFIG.GRID_W; x++) {
                if (MAP_DATA[y][x] === 1) {
                    // Check for Vestibule pillars (visual only, but cast shadows)
                    // Actually all walls cast shadows.
                    // Skip rendering shadow for walls that are surrounded? 
                    // No, let's draw all. Overdraw handles it.
                    this.drawWallShadow(sCtx, x, y, camX, camY, tileSize, sun.shadowVec);
                }
            }
        }

        // B. Entity Shadows
        gameState.npcs.forEach(npc => this.drawEntityShadow(sCtx, npc, camX, camY, tileSize, sun.shadowVec));
        Object.values(gameState.players).forEach(p => this.drawEntityShadow(sCtx, p, camX, camY, tileSize, sun.shadowVec));
        
        // Shop Shadow
        this.drawShopShadow(sCtx, camX, camY, tileSize, sun.shadowVec);

        // COMPOSITE SHADOWS
        ctx.save();
        // Shadow alpha varies by time (0.4 at noon, 0.7 at dawn/dusk for length effect)
        ctx.globalAlpha = 0.4 * sun.intensity; 
        ctx.drawImage(this.shadowCanvas, 0, 0);
        ctx.restore();
    }

    // 3. Draw Walls, Props, and Entities (Sorted by Row)
    for (let y = 0; y < CONFIG.GRID_H; y++) {
        // A. Draw Walls for this row
        for (let x = 0; x < CONFIG.GRID_W; x++) {
            if (MAP_DATA[y][x] === 1) {
                const pos = this.gridToScreen(x, y, camX, camY);
                // Cull off-screen with a larger margin so walls de-render later
                if (
                    pos.x < -tileSize * 3 ||
                    pos.x > width + tileSize * 3 ||
                    pos.y < -tileSize * 3 ||
                    pos.y > height + tileSize * 2
                ) continue;

                // Dynamic Perspective Calculation
                // Walls skew based on player position
                const shearX = (x - camX) * 1.5; 
                const shear = shearX * (tileSize / 32);
                
                const topX = pos.x + shear;
                const topY = pos.y - tileSize;

                const gateX = Math.floor(CONFIG.GRID_W / 2);
                const gateY = Math.floor(CONFIG.GRID_H / 2);
                
                const isLeftGate = (x === 0 && y === gateY);
                const isRightGate = (x === CONFIG.GRID_W - 1 && y === gateY);
                const isTopGate = (x === gateX && y === 0);
                const isBottomGate = (x === gateX && y === CONFIG.GRID_H - 1);

                // 1. Side Gate Floor Indicator (Glow)
                if (isLeftGate || isRightGate) {
                     const dist = Math.abs(x - camX);
                     const intensity = Math.max(0.3, 1.2 - dist / 10);
                     
                     ctx.save();
                     const gX = isLeftGate ? pos.x + tileSize : pos.x;
                     const gY = pos.y + tileSize / 2;
                     
                     const gradient = ctx.createRadialGradient(gX, gY, 1, gX, gY, tileSize * 2.5);
                     gradient.addColorStop(0, `rgba(200, 230, 255, ${0.4 * intensity})`);
                     gradient.addColorStop(0.5, `rgba(100, 200, 255, ${0.1 * intensity})`);
                     gradient.addColorStop(1, 'rgba(0,0,0,0)');
                     
                     ctx.fillStyle = gradient;
                     ctx.fillRect(pos.x - tileSize*2, pos.y - tileSize, tileSize * 5, tileSize * 3);
                     ctx.restore();
                }

                // 2. Draw Side Faces (The "3D" extrusion)
                // Only draw side faces for the outer boundary walls to avoid internal saw-toothing
                if (x === 0 || x === CONFIG.GRID_W - 1) {
                    ctx.save();
                    
                    // We use a transform to map the wall texture onto the sheared side face parallelogram
                    // Origin of the transform depends on which side we are drawing
                    const originX = (x === 0) ? pos.x + tileSize : pos.x;
                    
                    // Matrix transformation:
                    // x' = (shear/tileSize)*x + 0*y + originX
                    // y' = -1*x + 1*y + pos.y
                    // This maps the texture rectangle (0,0,w,h) to the parallelogram
                    ctx.setTransform(
                        shear / tileSize, // Horizontal Skew (Slope of the depth vector)
                        -1,               // Vertical Skew (Depth goes UP)
                        0,                // No Horizontal skew from Y
                        1,                // Vertical Scale
                        originX,          // Translate X
                        pos.y             // Translate Y
                    );

                    // Draw the wall texture onto the side face
                    ctx.drawImage(ASSETS.wall, 0, 0, tileSize, tileSize);

                    // Darken the side face for depth perception
                    ctx.fillStyle = 'rgba(0,0,0,0.6)';
                    ctx.fillRect(0, 0, tileSize, tileSize);

                    // Draw Gate Hole on the side face if needed
                    if ((x === 0 && isLeftGate) || (x === CONFIG.GRID_W - 1 && isRightGate)) {
                        ctx.fillStyle = '#1a1a1a'; // Match void color
                        ctx.beginPath();
                        // Center of the texture in transformed space
                        ctx.ellipse(tileSize/2, tileSize/2, tileSize * 0.25, tileSize * 0.35, 0, 0, Math.PI * 2);
                        ctx.fill();
                    }

                    ctx.restore();
                }

                // 3. Draw Front Face
                if (isTopGate || isBottomGate) {
                    // Top/Bottom Gate Arch
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(pos.x, pos.y, tileSize, tileSize);
                    
                    const cx = pos.x + tileSize / 2;
                    const bottom = pos.y + tileSize;
                    const doorW = tileSize * 0.5; 
                    const arcCy = bottom - tileSize * 0.5;

                    ctx.moveTo(cx + doorW, bottom);
                    ctx.lineTo(cx + doorW, arcCy);
                    ctx.arc(cx, arcCy, doorW, 0, Math.PI, true);
                    ctx.lineTo(cx - doorW, bottom);
                    ctx.closePath();
                    
                    ctx.clip();
                    ctx.drawImage(ASSETS.wall, pos.x, pos.y, tileSize, tileSize);
                    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();
                    ctx.restore();
                } else {
                    // Standard Solid Front
                    ctx.drawImage(ASSETS.wall, pos.x, pos.y, tileSize, tileSize);
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'; // Front face is darker
                    ctx.fillRect(pos.x, pos.y, tileSize, tileSize);
                }

                // 4. Draw Top Face
                // We slightly expand the width to cover small gaps caused by differential shearing between adjacent tiles
                const gapFix = Math.ceil(Math.abs(shearX * (tileSize/32) * 1.5)) + 2; 
                ctx.drawImage(ASSETS.wall, topX, topY, tileSize + gapFix, tileSize);
            }
        }

        // B. Draw Shop (Base at row 3)
        // ... existing code ...
    }

    drawWallShadow(ctx, x, y, camX, camY, tileSize, shadowVec) {
        const pos = this.gridToScreen(x, y, camX, camY);
        const size = tileSize;
        
        // Base Rectangle (The footprint of the wall on the ground)
        // Top-Left at pos.x, pos.y
        const bx = pos.x;
        const by = pos.y;
        
        // Projected Offset
        const ox = shadowVec.x * size;
        const oy = shadowVec.y * size;

        // Draw the convex hull of the Box Projection
        // We draw the 4 side faces connecting Base to Projected Top
        // And the Projected Top itself.
        
        ctx.beginPath();
        
        // Top Face Projection
        ctx.moveTo(bx + ox, by + oy);
        ctx.lineTo(bx + size + ox, by + oy);
        ctx.lineTo(bx + size + ox, by + size + oy);
        ctx.lineTo(bx + ox, by + size + oy);
        ctx.closePath();
        ctx.fill();

        // Connectors (Side Faces)
        // West Face
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + ox, by + oy);
        ctx.lineTo(bx + ox, by + size + oy);
        ctx.lineTo(bx, by + size);
        ctx.fill();

        // East Face
        ctx.beginPath();
        ctx.moveTo(bx + size, by);
        ctx.lineTo(bx + size + ox, by + oy);
        ctx.lineTo(bx + size + ox, by + size + oy);
        ctx.lineTo(bx + size, by + size);
        ctx.fill();
        
        // North Face (Back)
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + ox, by + oy);
        ctx.lineTo(bx + size + ox, by + oy);
        ctx.lineTo(bx + size, by);
        ctx.fill();

        // South Face (Front)
        ctx.beginPath();
        ctx.moveTo(bx, by + size);
        ctx.lineTo(bx + ox, by + size + oy);
        ctx.lineTo(bx + size + ox, by + size + oy);
        ctx.lineTo(bx + size, by + size);
        ctx.fill();
    }

    drawEntityShadow(ctx, entity, camX, camY, tileSize, shadowVec) {
        const pos = this.gridToScreen(entity.x - 0.5, entity.y - 0.5, camX, camY);
        const cx = pos.x + tileSize / 2;
        const cy = pos.y + tileSize / 2;
        
        ctx.save();
        // Pivot at feet
        const pivotY = cy + tileSize * 0.2;
        
        ctx.translate(cx, pivotY);
        
        // Transform for projection
        // Map Unit Up (0, -1) to (sx, sy) * size
        const sx = shadowVec.x; 
        const sy = shadowVec.y; 
        
        // Since entity Y is Up (-1), and we want it to project to (sx, sy),
        // we set the Y basis of the transform to (-sx, -sy).
        // X basis remains (1, 0) to keep width perpendicular to sun vector?
        // Actually, "authentic" shadows skew width too if sun is side-on.
        // But for 2D sprites, usually we just shear.
        
        ctx.transform(1, 0, -sx, -sy, 0, 0);
        
        // Draw Shadow Blob (upright, transform handles skew)
        drawCharacterShadow(ctx, entity, tileSize);
        
        ctx.restore();
    }

    drawShopShadow(ctx, camX, camY, tileSize, shadowVec) {
        // Shop is at x=3, y=2 (Base). Size 3x2 tiles.
        // But it's a "booth". Let's assume it's a box of height ~1.5 tiles.
        const x = 3;
        const y = 2;
        const wTiles = 3;
        const hTiles = 1.5; // Depth on ground
        const heightScale = 1.5; // Height of structure

        const pos = this.gridToScreen(x, y, camX, camY);
        
        const bx = pos.x;
        const by = pos.y + (0.5 * tileSize); // Offset base slightly down to align with sprite feet
        const bw = wTiles * tileSize;
        const bh = hTiles * tileSize;
        
        const ox = shadowVec.x * tileSize * heightScale;
        const oy = shadowVec.y * tileSize * heightScale;

        // Draw Cube Shadow Logic for the Shop Box
        ctx.beginPath();
        // Projected Top
        ctx.moveTo(bx + ox, by + oy);
        ctx.lineTo(bx + bw + ox, by + oy);
        ctx.lineTo(bx + bw + ox, by + bh + oy);
        ctx.lineTo(bx + ox, by + bh + oy);
        ctx.fill();

        // Connectors (simplified - just draw corners to corners)
        const corners = [
            {x: bx, y: by},
            {x: bx + bw, y: by},
            {x: bx + bw, y: by + bh},
            {x: bx, y: by + bh}
        ];

        corners.forEach(c => {
            ctx.beginPath();
            ctx.moveTo(c.x, c.y);
            ctx.lineTo(c.x + ox, c.y + oy);
            // Connect to neighbors for full quad fill?
            // Actually, simpler: Draw the 4 side faces
        });
        
        // West Side
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + ox, by + oy);
        ctx.lineTo(bx + ox, by + bh + oy);
        ctx.lineTo(bx, by + bh);
        ctx.fill();

        // East Side
        ctx.beginPath();
        ctx.moveTo(bx + bw, by);
        ctx.lineTo(bx + bw + ox, by + oy);
        ctx.lineTo(bx + bw + ox, by + bh + oy);
        ctx.lineTo(bx + bw, by + bh);
        ctx.fill();

        // Front Side (South)
        ctx.beginPath();
        ctx.moveTo(bx, by + bh);
        ctx.lineTo(bx + ox, by + bh + oy);
        ctx.lineTo(bx + bw + ox, by + bh + oy);
        ctx.lineTo(bx + bw, by + bh);
        ctx.fill();
        
        // Back Side (North)
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + ox, by + oy);
        ctx.lineTo(bx + bw + ox, by + oy);
        ctx.lineTo(bx + bw, by);
        ctx.fill();
    }
// ... existing code ...