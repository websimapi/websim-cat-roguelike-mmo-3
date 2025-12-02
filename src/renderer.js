import { CONFIG, MAP_DATA } from './config.js';
import { ASSETS } from './assets.js';
import { drawCharacter, drawCharacterShadow } from './character-renderer.js';
import { drawWall } from './wall-renderer.js';

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        
        // Shadow layer to prevent double-darkening
        this.shadowCanvas = document.createElement('canvas');
        this.shadowCtx = this.shadowCanvas.getContext('2d');
        
        // Reusable bucket arrays to reduce GC
        this.entitiesByRow = Array.from({ length: CONFIG.GRID_H }, () => []);
        
        this.cachedFloor = null;

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        
        // Only force rotate for Phones (width < 760px in portrait), not Tablets
        const isPhonePortrait = h > w && w < 760;

        // When in phone portrait we rotate the game-container 90deg via CSS.
        // Make the canvas match the rotated landscape area (use the larger dimension as width).
        if (isPhonePortrait) {
            this.canvas.width = h;
            this.canvas.height = w;
        } else {
            this.canvas.width = w;
            this.canvas.height = h;
        }

        this.ctx.imageSmoothingEnabled = false;
        
        // Invalidate floor cache on resize as tilesize might change (if we supported dynamic zoom, currently hardcoded scale)
        this.cachedFloor = null;
        
        // Resize shadow canvas
        this.shadowCanvas.width = this.canvas.width;
        this.shadowCanvas.height = this.canvas.height;
    }

    // Helper to convert grid coords to screen pixels
    gridToScreen(gx, gy, camX, camY) {
        const centerScreenX = this.canvas.width / 2;
        const centerScreenY = this.canvas.height / 2;
        const tileSize = CONFIG.TILE_SIZE * CONFIG.SCALE;

        const screenX = centerScreenX + (gx - camX) * tileSize;
        const screenY = centerScreenY + (gy - camY) * tileSize;
        
        return { x: screenX, y: screenY, size: tileSize };
    }

    getSunState() {
        const now = Date.now();
        const cyclePos = (now % CONFIG.DAY_LENGTH) / CONFIG.DAY_LENGTH; // 0 to 1
        
        // Cycle:
        // 0.0 - 0.2: Night (Moon)
        // 0.2 - 0.3: Dawn
        // 0.3 - 0.7: Day
        // 0.7 - 0.8: Dusk
        // 0.8 - 1.0: Night

        let intensity = 0;
        let ambientColor = 'rgba(0,0,20,0.6)'; // Deep night
        let shadowVec = { x: 0, y: 0 };
        let sunHeight = 0;

        if (cyclePos >= 0.2 && cyclePos < 0.8) {
            // Daytime phase (0.2 to 0.8 = 0.6 duration)
            const dayProgress = (cyclePos - 0.2) / 0.6; // 0 to 1
            
            // Sun Arc: East -> South -> West
            // Shadow Vector: Points West -> North -> East
            
            // Sun Height (0 at horizon, 1 at noon)
            // Sine wave from 0 to PI
            sunHeight = Math.sin(dayProgress * Math.PI);
            
            // Shadow Length = 1 / tan(height). Clamp to avoid infinity.
            // When height is 0, length is infinite.
            // We'll approximate:
            const shadowLen = 2.5 * (1 - sunHeight) + 0.5; // Shortest 0.5 at noon, Longest 3.0 at horizon
            
            // Shadow Direction
            // dayProgress 0 (Sunrise) -> Shadow points Left (-1, 0)
            // dayProgress 0.5 (Noon) -> Shadow points Back/North (0, -1) 
            // dayProgress 1 (Sunset) -> Shadow points Right (1, 0)
            
            // Let's use cosine for X direction
            // 0 -> -1
            // 0.5 -> 0
            // 1 -> 1
            const dirX = -Math.cos(dayProgress * Math.PI);
            
            // Y Direction: Always pointing somewhat "North" (negative Y) to look good in top down
            // But usually shadows rotate.
            // Let's make it rotate around the bottom (South)
            // Sunrise: Left. Noon: Up. Sunset: Right.
            const dirY = -Math.sin(dayProgress * Math.PI) * 0.5; // * 0.5 to flatten the oval path
            
            shadowVec = { x: dirX * shadowLen, y: dirY * shadowLen };
            
            // Brightness / Color
            if (dayProgress < 0.1 || dayProgress > 0.9) {
                // Dawn/Dusk
                ambientColor = `rgba(255, 100, 50, ${0.4 * (1 - sunHeight)})`; // Orange Tint
                intensity = sunHeight; 
            } else {
                // Mid-day
                ambientColor = 'rgba(0,0,0,0)'; // Clear
                intensity = 1.0;
            }
        } else {
            // Night
            // Minimal moon shadows?
            shadowVec = { x: 0.5, y: -0.5 }; // Fixed moon shadow
            intensity = 0.2;
        }

        return { shadowVec, intensity, ambientColor };
    }

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
        const gateX = 11;

        // Clear buckets
        this.entitiesByRow.forEach(row => row.length = 0);

        // Helper to add entity to row bucket
        const addToBucket = (type, obj) => {
            const r = Math.floor(obj.y);
            if (r >= 0 && r < CONFIG.GRID_H) {
                this.entitiesByRow[r].push({ type, obj });
            }
        };

        // Add NPCs, Players, Projectiles
        gameState.npcs.forEach(npc => addToBucket('npc', npc));
        Object.values(gameState.players).forEach(p => addToBucket('player', p));
        gameState.projectiles.forEach(p => addToBucket('projectile', p));

        // Create cached floor tile if needed
        if (!this.cachedFloor && ASSETS.loaded) {
            this.cachedFloor = document.createElement('canvas');
            this.cachedFloor.width = tileSize;
            this.cachedFloor.height = tileSize;
            const fCtx = this.cachedFloor.getContext('2d');
            const subSize = tileSize / 2;
            for (let oy = 0; oy < 2; oy++) {
                for (let ox = 0; ox < 2; ox++) {
                    fCtx.drawImage(ASSETS.floor, ox * subSize, oy * subSize, subSize, subSize);
                }
            }
        }

        // 1. Draw ALL Floors First (Background Layer)
        const floorCullMarginX = tileSize * 2;
        const floorCullMarginY = tileSize * 2;
        for (let y = 0; y < CONFIG.GRID_H; y++) {
            for (let x = 0; x < CONFIG.GRID_W; x++) {
                const pos = this.gridToScreen(x, y, camX, camY);
                if (
                    pos.x < -floorCullMarginX ||
                    pos.x > width + floorCullMarginX ||
                    pos.y < -floorCullMarginY ||
                    pos.y > height + floorCullMarginY
                ) continue;
                
                if (this.cachedFloor) {
                    this.ctx.drawImage(this.cachedFloor, pos.x, pos.y);
                }
            }
        }

        // 2. SHADOW PASS
        // We draw all shadows onto a separate canvas (sCtx) using solid black
        // Then we draw that canvas onto the main canvas with a single alpha value
        // This ensures overlapping shadows merge instead of getting darker
        sCtx.clearRect(0, 0, width, height);
        
        if (sun.intensity > 0.05) {
            sCtx.fillStyle = '#000000';
            
            // A. Wall Shadows
            for (let y = 0; y < CONFIG.GRID_H; y++) {
                for (let x = 0; x < CONFIG.GRID_W; x++) {
                    if (MAP_DATA[y][x] === 1) {
                         // Check for North Vestibule internal pillars or South Vestibule
                        const isVestibule = (y === 1 || y === CONFIG.GRID_H) && (x === gateX - 1 || x === gateX + 1);
                        // Standard walls + vestibule pillars cast shadows
                        // We skip non-rendering walls? No, MAP_DATA 1 means wall.
                        
                        this.drawWallShadow(sCtx, x, y, camX, camY, tileSize, sun.shadowVec);
                    }
                }
            }

            // B. Entity Shadows
            // Characters
            gameState.npcs.forEach(npc => this.drawEntityShadow(sCtx, npc, camX, camY, tileSize, sun.shadowVec));
            Object.values(gameState.players).forEach(p => this.drawEntityShadow(sCtx, p, camX, camY, tileSize, sun.shadowVec));
            
            // Shop Shadow (Fixed location)
            this.drawShopShadow(sCtx, camX, camY, tileSize, sun.shadowVec);

            // COMPOSITE SHADOWS
            ctx.save();
            // Shadow alpha varies by time (0.4 at noon, 0.7 at dawn/dusk)
            ctx.globalAlpha = 0.5 * sun.intensity; 
            ctx.drawImage(this.shadowCanvas, 0, 0);
            ctx.restore();
        }

        // 3. Draw Walls, Props, and Entities (Sorted by Row)
        for (let y = 0; y < CONFIG.GRID_H; y++) {
            // A. Draw Shop (Base at row 3)
            if (y === 3) {
                const shopPos = this.gridToScreen(3, 2, camX, camY);
                ctx.drawImage(ASSETS.shop, shopPos.x, shopPos.y, tileSize * 3, tileSize * 2);
            }

            // B. Draw Entities for this row
            this.entitiesByRow[y].sort((a, b) => a.obj.y - b.obj.y);
            
            this.entitiesByRow[y].forEach(item => {
                if (item.type === 'projectile') {
                    this.drawProjectile(ctx, item.obj, camX, camY, tileSize);
                } else {
                    const pos = this.gridToScreen(item.obj.x - 0.5, item.obj.y - 0.5, camX, camY);
                    drawCharacter(ctx, item.obj, pos.x, pos.y, tileSize, item.type === 'npc');
                }
            });

            // C. Draw Walls for this row
            // ... existing code ...
            if (y === CONFIG.GRID_H - 1) {
                drawWall(this, gateX - 1, CONFIG.GRID_H, camX, camY);
                drawWall(this, gateX + 1, CONFIG.GRID_H, camX, camY);
            }

            if (y === 0) {
                const northGateX = Math.floor(CONFIG.GRID_W / 2);
                drawWall(this, northGateX - 1, 1, camX, camY);
                drawWall(this, northGateX + 1, 1, camX, camY);
            }

            for (let x = 0; x < CONFIG.GRID_W; x++) {
                if (MAP_DATA[y][x] === 1) {
                    const northGateX = Math.floor(CONFIG.GRID_W / 2);
                    const isNorthVestibulePillar =
                        (y === 1 && (x === northGateX - 1 || x === northGateX + 1));
                    if (isNorthVestibulePillar) continue;

                    drawWall(this, x, y, camX, camY);
                }
            }
        }

        // 4. Day/Night Overlay
        ctx.save();
        ctx.fillStyle = sun.ambientColor;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
    }

    drawWallShadow(ctx, x, y, camX, camY, tileSize, shadowVec) {
        const pos = this.gridToScreen(x, y, camX, camY);
        
        // Calculate offsets
        // Wall top is at (x, y) visually (ignoring perspective shear for shadow calc simplicity, 
        // effectively treating it as a block rising from y+tileSize to y)
        // Actually, in our rendering:
        // Base is at pos.y + tileSize? No, pos is top-left of tile.
        // Wall occupies the tile (pos.x, pos.y) to (pos.x+size, pos.y+size).
        // Front face is at Y+size? No.
        // Let's assume standard tile bounds.
        
        const size = tileSize;
        // Base Coordinates (on the ground)
        // Since it's a top-down tile, the "base" of the wall is the same as its footprint.
        // The "Top" face is lifted by 'size' in Z (which is -Y in screen space typically, but here we used perspective shear).
        // Let's approximate the wall as a 1-unit high box.
        
        const bx = pos.x;
        const by = pos.y;
        
        // Projected Top Face Coordinates
        const ox = shadowVec.x * size;
        const oy = shadowVec.y * size;

        // Shadow is the convex hull of the base rect and the projected top rect
        // Base Rect: (bx, by) -> (bx+size, by+size)
        // Projected Rect: (bx+ox, by+oy) -> (bx+size+ox, by+size+oy)
        
        ctx.beginPath();
        
        // Trace the silhouette logic simplified:
        // Just draw the connector quad for the two visible edges + the projected top
        
        // 1. Projected Top Face
        ctx.moveTo(bx + ox, by + oy);
        ctx.lineTo(bx + size + ox, by + oy);
        ctx.lineTo(bx + size + ox, by + size + oy);
        ctx.lineTo(bx + ox, by + size + oy);
        ctx.closePath();
        
        // 2. Connect corners (Hull)
        // We can just draw the hull polygon directly if we know which corners are extreme.
        // Or simpler: Draw the projected rect, and the 4 connecting quads (some will be internal).
        // Since we are drawing solid black to an offscreen canvas, overdraw is fine.
        
        // Left Face Projection
        ctx.moveTo(bx, by);
        ctx.lineTo(bx, by + size);
        ctx.lineTo(bx + ox, by + size + oy);
        ctx.lineTo(bx + ox, by + oy);
        
        // Right Face Projection
        ctx.moveTo(bx + size, by);
        ctx.lineTo(bx + size, by + size);
        ctx.lineTo(bx + size + ox, by + size + oy);
        ctx.lineTo(bx + size + ox, by + oy);
        
        // Top Face Projection (Edge connecting wall top to shadow top)
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + size, by);
        ctx.lineTo(bx + size + ox, by + oy);
        ctx.lineTo(bx + ox, by + oy);
        
        // Bottom Face Projection
        ctx.moveTo(bx, by + size);
        ctx.lineTo(bx + size, by + size);
        ctx.lineTo(bx + size + ox, by + size + oy);
        ctx.lineTo(bx + ox, by + size + oy);

        ctx.fill();
    }

    drawEntityShadow(ctx, entity, camX, camY, tileSize, shadowVec) {
        const pos = this.gridToScreen(entity.x - 0.5, entity.y - 0.5, camX, camY);
        const cx = pos.x + tileSize / 2;
        const cy = pos.y + tileSize / 2;
        
        ctx.save();
        // Move to feet position
        // Feet are roughly at cy + 4*scale. 
        // Let's assume pivot is at (cx, cy + tileSize/4)
        const pivotY = cy + tileSize * 0.2;
        
        ctx.translate(cx, pivotY);
        
        // Apply Shear Skew
        // Transform: x' = x + y * sx, y' = y * sy
        // We want the vertical axis (0, -1) to map to (shadowVec.x, shadowVec.y) * tileSize
        // Note: Entity local Y is Up (-1).
        
        // Canvas transform(a, b, c, d, e, f)
        // x' = ax + cy + e
        // y' = bx + dy + f
        // We want vector (0, -1) [Unit Up] to become (shadowVec.x, shadowVec.y) * size
        // So c(-1) = sx * size  => c = -sx * size
        //    d(-1) = sy * size  => d = -sy * size
        // And we want vector (1, 0) [Unit Right] to remain roughly (1, 0) * aspect? 
        // Usually shadows flatten.
        
        // Let's use a explicit shear/scale matrix
        // Scale Y by 0.5 (flatten on ground)
        // Skew X based on sun angle?
        
        // Let's stick to the vector mapping logic.
        // We map the Sprite's coordinate space to the Floor.
        
        const sx = shadowVec.x; // Shadow shift per unit height
        const sy = shadowVec.y; 
        
        // Matrix:
        // Horizontal: Unchanged (1, 0)
        // Vertical: Maps to (sx, sy)
        // But sprite draws up (-h). So -h * M should be (sx*h, sy*h).
        // So M_vertical = (-sx, -sy).
        
        ctx.transform(1, 0, -sx, -sy, 0, 0);
        
        // Scale down the shadow height? 
        // The shadow vector length handles elongation.
        // But we might want to squash the width of the shadow if sun is to the side?
        // Let's keep width 1.0.
        
        // Draw Shadow Blob (approximate character shape)
        // Character is drawn centered at (0,0) after translate.
        // We need to draw 'inverted' relative to the skew? No, the skew handles the projection.
        // Just draw the character shape upright, and the skew lays it down.
        
        drawCharacterShadow(ctx, entity, tileSize);
        
        ctx.restore();
    }

    drawShopShadow(ctx, camX, camY, tileSize, shadowVec) {
        const pos = this.gridToScreen(3, 2, camX, camY);
        const w = tileSize * 3;
        const h = tileSize * 2;
        
        // Shop is a billboard at (pos.x, pos.y)
        // Base is at pos.y + h.
        
        ctx.save();
        ctx.translate(pos.x + w/2, pos.y + h); // Bottom Center
        
        const sx = shadowVec.x;
        const sy = shadowVec.y;
        
        ctx.transform(1, 0, -sx, -sy, 0, 0);
        
        // Draw Black Rect for shop
        // Origin is bottom center. Shop goes from -w/2 to w/2, and 0 to -h.
        ctx.fillRect(-w/2, -h, w, h);
        
        // Add Awing detail (triangle on side?)
        // simplified box is enough for the shop
        ctx.restore();
    }

    drawProjectile(ctx, proj, camX, camY, tileSize) {
        const pos = this.gridToScreen(proj.x - 0.5, proj.y - 0.5, camX, camY);
        const r = (CONFIG.PROJECTILE_RADIUS || 0.1) * tileSize;
        ctx.fillStyle = '#00ffff'; 
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00ffff';
        ctx.beginPath();
        ctx.arc(pos.x + tileSize/2, pos.y + tileSize/2, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
}