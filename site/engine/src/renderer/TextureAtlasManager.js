// TextureAtlasManager.js
// Manages materials and sprites in the WebGL texture atlas.
// Optimizes performance by using gl.texSubImage2D updates.
//
// The first RENDERER_STATIC_ATLAS_SLOTS cells are the static half: one baked
// cell per slot, addressed by index from scene geometry. The engine owns how a
// slot is baked and how many there are. Which material lands in which slot is
// the loaded world's to say, through `setStaticMaterialSlots` - see
// WALL_MATERIAL_ATLAS_SLOTS in world/WorldAssets.js for this game's table.
//
// With no table installed the engine bakes the identity: slot N draws whatever
// was registered under material id N. That renders an atlas for a consumer who
// has not said anything yet, and it names nothing.

import { encodeMaterialProperties } from './MaterialProperties.js';
import { startupTrace } from './StartupTrace.js';
import {
  RENDERER_ATLAS_COLUMNS,
  RENDERER_STATIC_ATLAS_ROWS,
  RENDERER_STATIC_ATLAS_SLOTS,
  RENDERER_TOTAL_ATLAS_SLOTS,
  resolveAtlasLayout
} from './RendererScalability.js';

/**
 * Normalises an installed slot table into one entry per static slot.
 *
 * Accepts an array indexed by slot, or an object keyed by slot number. An entry
 * is a material id, or `{ material, bakeIntensity }` where `bakeIntensity` is
 * the third argument handed to `getChar` while baking - the one a floor or a
 * ceiling reads as an average light level rather than as a wall side. Returns
 * null for no table, which is what selects the engine's identity default.
 */
export function normalizeStaticMaterialSlots(slots, staticSlotCount = RENDERER_STATIC_ATLAS_SLOTS) {
  if (!slots || typeof slots !== 'object') return null;
  resolveAtlasLayout(staticSlotCount);
  const table = new Array(staticSlotCount).fill(null);
  const entries = Array.isArray(slots)
    ? Array.from(slots, (value, index) => [index, value])
    : Object.entries(slots);

  for (const [key, value] of entries) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= staticSlotCount) {
      // Dropping this quietly is how a material goes missing with no symptom
      // but an empty surface, so it is said out loud at install time.
      console.warn(`[TextureAtlas] Ignoring static material slot ${key}: the atlas has ` +
        `${staticSlotCount} static slots, 0 to ${staticSlotCount - 1}.`);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number') {
      table[index] = { material: value, bakeIntensity: 0 };
      continue;
    }
    if (typeof value !== 'object') continue;
    const material = value.material !== undefined ? value.material : value.id;
    if (material === null || material === undefined) continue;
    table[index] = {
      material,
      bakeIntensity: Number.isFinite(value.bakeIntensity) ? value.bakeIntensity : 0
    };
  }
  return table;
}

function staticSlotTablesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (!left || !right) return false;
    if (left.material !== right.material || left.bakeIntensity !== right.bakeIntensity) return false;
  }
  return true;
}

/** Slot N draws material N: the engine's table when no world has installed one. */
const IDENTITY_STATIC_MATERIAL_SLOTS = Object.freeze(
  Array.from({ length: RENDERER_STATIC_ATLAS_SLOTS }, (_unused, index) =>
    Object.freeze({ material: index, bakeIntensity: 0 }))
);

/** No table entry fills this slot; geometry addressing it samples cleared atlas. */
export const STATIC_SLOT_EMPTY = 'empty';
/** The table names a material for this slot that nobody registered. */
export const STATIC_SLOT_UNREGISTERED = 'unregistered';
/** Past the static half entirely - that index samples the dynamic sprite cells. */
export const STATIC_SLOT_OUT_OF_RANGE = 'out_of_range';
/** Baked, and safe to point geometry at. */
export const STATIC_SLOT_BAKED = 'baked';

export default class TextureAtlasManager {
  constructor(gl, diffuseTexture, materialTexture, materials, spriteTemplates, {staticAtlasSlots} = {}) {
    this.gl = gl;
    this.diffuseTexture = diffuseTexture;
    this.materialTexture = materialTexture;
    this.materials = materials;
    this.spriteTemplates = spriteTemplates;
    this.atlasLayout = resolveAtlasLayout(staticAtlasSlots);
    this.identityStaticSlots = Object.freeze(Array.from({length:this.atlasLayout.staticSlots},
      (_, material) => Object.freeze({material, bakeIntensity:0})));

    this.cellSize = 64;
    this.atlasSize = 1024;
    // What each dynamic sprite cell currently holds, keyed by atlas index. A
    // template marked `static: true` never animates, so its cell only redraws
    // when a different sprite type rotates into it - not every frame.
    this.dynamicCellContent = new Map();

    this.atlasCanvas = document.createElement('canvas');
    this.atlasCanvas.width = this.atlasSize;
    this.atlasCanvas.height = this.atlasSize;
    this.atlasCtx = this.atlasCanvas.getContext('2d');
    this.materialCanvas = document.createElement('canvas');
    this.materialCanvas.width = this.atlasSize;
    this.materialCanvas.height = this.atlasSize;
    this.materialCtx = this.materialCanvas.getContext('2d');


    this.spriteScratchCanvas = document.createElement('canvas');
    this.spriteScratchCanvas.width = this.cellSize;
    this.spriteScratchCanvas.height = this.cellSize;
    this.spriteScratchCtx = this.spriteScratchCanvas.getContext('2d');

    this.pixelBuffer = new Uint8Array(this.cellSize * this.cellSize * 4);
    this.materialPixelBuffer = new Uint8Array(this.cellSize * this.cellSize * 4);

    // The static half is written as pixels and blitted in one call rather than
    // painted. Allocated on the first bake, because the size follows cellSize
    // and that can change under onAtlasSizeChanged. See drawStaticMaterials.
    this.staticDiffuseImage = null;
    this.staticMaterialImage = null;

    // Null until a world installs its table. See normalizeStaticMaterialSlots.
    this.staticMaterialSlots = null;
    this.reportedSlotProblems = new Set();
    this.staticMaterialsDirty = true;
  }

  /**
   * Installs which material is baked into each of the static atlas slots.
   *
   * Install it once at startup, the way `setAtmosphereProfiles` is installed.
   * Pass null to go back to the engine's identity table. Marks the static half
   * dirty, so a table swapped at runtime rebakes on the next frame.
   */
  setStaticMaterialSlots(slots) {
    const next = normalizeStaticMaterialSlots(slots, this.atlasLayout?.staticSlots);
    // Reinstalling an identical table must not invalidate: the bake behind it
    // costs tens of milliseconds, and a caller re-asserting its table per frame
    // would otherwise turn that into a per-frame cost.
    if (staticSlotTablesEqual(next, this.staticMaterialSlots)) return this;
    this.staticMaterialSlots = next;
    this.invalidateStaticMaterials();
    return this;
  }

  /** The installed table, or the identity one the engine falls back to. */
  getStaticMaterialSlots() {
    return this.staticMaterialSlots || this.identityStaticSlots || IDENTITY_STATIC_MATERIAL_SLOTS;
  }

  /**
   * Whether a slot will bake, and if not, why not.
   *
   * Answered from the table and the registered materials rather than from the
   * last bake, so it is the same answer whether or not a frame has been drawn
   * yet. That is what lets the renderer audit scene geometry at build time.
   */
  getStaticSlotStatus(index) {
    if (!Number.isInteger(index) || index < 0) return STATIC_SLOT_OUT_OF_RANGE;
    if (index >= (this.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS)) return STATIC_SLOT_OUT_OF_RANGE;
    const entry = this.getStaticMaterialSlots()[index];
    if (!entry) return STATIC_SLOT_EMPTY;
    return this.materials.get(entry.material) ? STATIC_SLOT_BAKED : STATIC_SLOT_UNREGISTERED;
  }

  /** The material id a slot is meant to bake, for a diagnostic to quote. */
  getStaticSlotMaterialId(index) {
    const entry = Number.isInteger(index) && index >= 0 && index < (this.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS)
      ? this.getStaticMaterialSlots()[index]
      : null;
    return entry ? entry.material : null;
  }

  /**
   * Rebakes the static half on the next frame, and lets its diagnostics speak
   * again - a slot that was broken before a material was registered is not
   * still broken afterwards, and the warning should not be stuck on either.
   */
  invalidateStaticMaterials() {
    this.staticMaterialsDirty = true;
    this.reportedSlotProblems.clear();
    // The pending static rebake re-uploads the whole atlas canvas, which
    // clobbers the dynamic half; every cached sprite cell must redraw after.
    this.dynamicCellContent.clear();
  }

  /**
   * Rebakes the static half now, because what its materials paint has changed.
   *
   * `invalidateStaticMaterials` on its own defers the bake to whoever draws
   * next, which is right for a slot table swapped before a frame exists and
   * wrong for a material whose colours moved under a running game: the world
   * keeps the surfaces it was baked with until something else happens to
   * invalidate them. A colour scheme change is exactly that - every
   * `WallMaterials.*.getColor` starts answering differently and nothing in the
   * atlas can tell - so this pairs the invalidation with the bake and takes the
   * cost at the moment the change was asked for.
   *
   * Measured 2026-08-07 through the real settings control, across all eight
   * resolution contracts - which offer only two atlas geometries between them:
   * **55-70ms at 128px cells** (`native`, `max`, `hyper`, `ultra`, `tiny`) and
   * **13-18ms at 64px cells** (`standard`, `large`, `dynamic`), the texture
   * upload being about 6ms and 1ms of those. One dropped frame on a settings
   * screen, so it blocks rather than announcing itself. The 88-130ms carried
   * in the tree since 7a547d6 no longer holds; this bakes 20 filled slots.
   *
   * Declines when a bake is already owed, which is what keeps it clear of the
   * load path: during startup the atlas is dirty from `registerMaterial` and
   * `setStaticMaterialSlots`, and `prewarmStaticAtlas` is going to bake it once
   * the first resize has settled the cell size. Baking here as well would be
   * the same work done twice, the first time at the wrong size.
   */
  rebakeStaticAtlas() {
    if (this.staticMaterialsDirty) return false;
    this.invalidateStaticMaterials();
    return this.refreshStaticMaterials();
  }

  /** Says a slot problem once per distinct problem, not once per frame. */
  reportStaticSlotProblem(index, detail) {
    const key = `${index}:${detail}`;
    if (this.reportedSlotProblems.has(key)) return false;
    this.reportedSlotProblems.add(key);
    console.warn(`[TextureAtlas] Static atlas slot ${index} ${detail}. ` +
      'Geometry pointing at it draws nothing.');
    return true;
  }

  onAtlasSizeChanged(cellSize, atlasSize) {
    this.cellSize = cellSize;
    this.atlasSize = atlasSize;
    this.dynamicCellContent.clear();
    
    this.atlasCanvas.width = atlasSize;
    this.atlasCanvas.height = atlasSize;
    this.materialCanvas.width = atlasSize;
    this.materialCanvas.height = atlasSize;
    this.spriteScratchCanvas.width = cellSize;
    this.spriteScratchCanvas.height = cellSize;
    
    this.pixelBuffer = new Uint8Array(cellSize * cellSize * 4);

    this.materialPixelBuffer = new Uint8Array(cellSize * cellSize * 4);
    this.staticDiffuseImage = null;
    this.staticMaterialImage = null;
    this.staticMaterialsDirty = true;
  }

  /**
   * Bakes one registered material into one static slot's cell.
   *
   * Writes texels into the shared static-half pixel buffers rather than onto a
   * canvas. It used to set `fillStyle` and call `fillRect(x, y, 1, 1)` once per
   * texel per canvas, which is 8192 painted rectangles and 8192 parsed CSS
   * colour strings per slot - 262,144 of each across the 32 static slots. On
   * the first frame of a floor that measured **860ms on the main thread**, and
   * it was the whole of the 1.0s freeze every session took a few seconds in.
   * The values written are identical: every material in this codebase returns
   * integer channels, and `encodeMaterialProperties` always returns alpha 255,
   * so nothing here went through the canvas's premultiplication either way.
   */
  bakeStaticMaterial(mat, bakeIntensity, col, row) {
    const cellSize = this.cellSize;
    const diffuse = this.staticDiffuseImage.data;
    const material = this.staticMaterialImage.data;
    const stride = this.staticDiffuseImage.width * 4;
    const originX = col * cellSize;
    const originY = row * cellSize;

    for (let py = 0; py < cellSize; py++) {
      const texY = py / (cellSize - 1);
      let index = (originY + py) * stride + originX * 4;
      for (let px = 0; px < cellSize; px++, index += 4) {
        const texX = px / (cellSize - 1);
        const colors = mat.getColor(texX, texY, 0);
        const char = mat.getChar(texX, texY, bakeIntensity, colors);
        const properties = mat.getProperties(texX, texY, char, colors);
        const [roughness, emission, lightResponse, alpha] = encodeMaterialProperties(properties);
        // `getChar` decides only whether the texel is written black - see the
        // deck plate note in world/WorldAssets.js, which depends on that.
        const written = char !== ' ';
        diffuse[index] = written ? colors.r : 0;
        diffuse[index + 1] = written ? colors.g : 0;
        diffuse[index + 2] = written ? colors.b : 0;
        diffuse[index + 3] = 255;
        material[index] = roughness;
        material[index + 1] = emission;
        material[index + 2] = lightResponse;
        material[index + 3] = alpha;
      }
    }
  }

  drawStaticMaterials() {
    const cellSize = this.cellSize;
    const staticWidth = cellSize * RENDERER_ATLAS_COLUMNS;
    const staticHeight = cellSize * (this.atlasLayout?.staticRows ?? RENDERER_STATIC_ATLAS_ROWS);

    // Reallocated only when the atlas geometry changes, so a rebake at a steady
    // size - a swapped slot table, a re-registered material - reuses these.
    if (!this.staticDiffuseImage
      || this.staticDiffuseImage.width !== staticWidth
      || this.staticDiffuseImage.height !== staticHeight) {
      this.staticDiffuseImage = this.atlasCtx.createImageData(staticWidth, staticHeight);
      this.staticMaterialImage = this.materialCtx.createImageData(staticWidth, staticHeight);
    }
    // Zeroing is the clear: a slot with no material stays fully transparent,
    // exactly as clearRect left it, and every baked texel is written outright.
    this.staticDiffuseImage.data.fill(0);
    this.staticMaterialImage.data.fill(0);

    const slots = this.getStaticMaterialSlots();
    for (let index = 0; index < (this.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS); index++) {
      const entry = slots[index];
      if (!entry) continue;
      const mat = this.materials.get(entry.material);
      if (!mat) {
        // An unfilled cell in the identity table is the ordinary case - it is a
        // guess, not a claim. An unfilled cell in an installed table is a typo
        // or a missing registerMaterial, and worth interrupting for.
        if (this.staticMaterialSlots) {
          this.reportStaticSlotProblem(index, `is assigned material '${String(entry.material)}', which is not registered`);
        }
        continue;
      }
      this.bakeStaticMaterial(
        mat,
        entry.bakeIntensity,
        index % RENDERER_ATLAS_COLUMNS,
        Math.floor(index / RENDERER_ATLAS_COLUMNS)
      );
    }

    // `putImageData` replaces the destination pixels rather than compositing
    // over them, which is what the clearRect-then-fill pair did.
    this.atlasCtx.putImageData(this.staticDiffuseImage, 0, 0);
    this.materialCtx.putImageData(this.staticMaterialImage, 0, 0);
  }

  /**
   * Bakes and uploads the static half, if anything has invalidated it.
   *
   * Separate from `updateTextureAtlas` so it can also be done at load, before a
   * frame is being presented - see AsciiRendererWebGL.setStaticMaterialSlots.
   * What is left after the fillRect removal above is the materials' own texel
   * maths, about 130ms across 20 baked slots, and that is irreducible without
   * changing what the facility looks like. Work that has to happen once and
   * cannot be made cheaper can still be made to happen while the screen is
   * black rather than on the first frame of a floor.
   *
   * Still driven by the dirty flag rather than done once at construction: a
   * material registered after the table is installed has to rebake, and the
   * lazy path is what guarantees the atlas is correct no matter what order a
   * consumer sets it up in.
   */
  refreshStaticMaterials() {
    if (!this.staticMaterialsDirty) return false;
    const gl = this.gl;
    startupTrace.span('atlas.drawStaticMaterials', () => this.drawStaticMaterials());
    this.staticMaterialsDirty = false;

    startupTrace.span('atlas.uploadStatic', () => {
      gl.bindTexture(gl.TEXTURE_2D, this.diffuseTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas);
      gl.bindTexture(gl.TEXTURE_2D, this.materialTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.materialCanvas);
    });
    return true;
  }

  updateTextureAtlas(activeSpriteIndices, currentTime) {
    const gl = this.gl;
    const cellSize = this.cellSize;

    this.refreshStaticMaterials();

    // Upload only the dynamic sprite cells that are active using fast raw typed array updates
    if (activeSpriteIndices && activeSpriteIndices.length > 0) {
      gl.bindTexture(gl.TEXTURE_2D, this.diffuseTexture);
      
      const pixelBuf = this.pixelBuffer;
      const materialPixelBuf = this.materialPixelBuffer;

      for (let i = 0; i < activeSpriteIndices.length; i++) {
        const { sprite, atlasIndex, templateType } = activeSpriteIndices[i];
        if (!Number.isInteger(atlasIndex) || atlasIndex < (this.atlasLayout?.staticSlots ?? RENDERER_STATIC_ATLAS_SLOTS) ||
            atlasIndex >= RENDERER_TOTAL_ATLAS_SLOTS) continue;
        // `templateType` is the resolved template name updateSpriteGeometry
        // allocated the cell for (an entity's `billboard` override, or the
        // type). Entries without it predate the field and key on the type.
        const templateName = templateType !== undefined ? templateType : sprite.type;
        const template = this.spriteTemplates.get(templateName);
        if (!template) continue;

        const contentKey = template.static === true ? templateName : null;
        if (contentKey !== null && this.dynamicCellContent.get(atlasIndex) === contentKey) {
          continue;
        }

        const col = atlasIndex % RENDERER_ATLAS_COLUMNS;
        const row = Math.floor(atlasIndex / RENDERER_ATLAS_COLUMNS);
        const xOffset = col * cellSize;
        const yOffset = row * cellSize;

        // Reset pixel buffer to fully transparent (0 alpha)
        pixelBuf.fill(0);
        materialPixelBuf.fill(0);

        const spriteArt = template.getArt(sprite, currentTime);
        if (spriteArt && spriteArt.length > 0) {
          const artRows = spriteArt.length;
          const artCols = spriteArt[0].length;
          
          for (let py = 0; py < cellSize; py++) {
            const texY = py / (cellSize - 1);
            const artY = Math.min(artRows - 1, Math.floor(texY * artRows));
            const artRow = spriteArt[artY];

            for (let px = 0; px < cellSize; px++) {
              const texX = px / (cellSize - 1);
              const artX = Math.min(artCols - 1, Math.floor(texX * artCols));
              const char = artRow[artX];

              if (char && char !== ' ') {
                const colors = template.getBaseColor(sprite, texY, currentTime, texX, char);
                const boost = Number.isFinite(template.colorBoost) ? Math.max(0, Math.min(4, template.colorBoost)) : 1.35;
                const r = Math.min(255, Math.floor(colors.r * boost));
                const g = Math.min(255, Math.floor(colors.g * boost));
                const b = Math.min(255, Math.floor(colors.b * boost));
                
                const idx = (py * cellSize + px) * 4;
                pixelBuf[idx] = r;
                pixelBuf[idx + 1] = g;
                pixelBuf[idx + 2] = b;
                pixelBuf[idx + 3] = 255;
                const properties = template.getProperties(sprite, texY, currentTime, texX, char);
                const encoded = encodeMaterialProperties(properties);
                materialPixelBuf[idx] = encoded[0];
                materialPixelBuf[idx + 1] = encoded[1];
                materialPixelBuf[idx + 2] = encoded[2];
                materialPixelBuf[idx + 3] = encoded[3];
              }
            }
          }
        }

        // Upload only this 64x64 sub-rectangle to the GPU texture directly
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          xOffset,
          yOffset,
          cellSize,
          cellSize,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixelBuf
        );
        gl.bindTexture(gl.TEXTURE_2D, this.materialTexture);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          xOffset,
          yOffset,
          cellSize,
          cellSize,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          materialPixelBuf
        );
        gl.bindTexture(gl.TEXTURE_2D, this.diffuseTexture);
        this.dynamicCellContent.set(atlasIndex, contentKey);
      }
    }
  }
}
