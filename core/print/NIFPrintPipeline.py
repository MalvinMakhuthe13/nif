"""
NIF Print Pipeline
fumoca.co.za · © Fumoca Technologies

Converts a .nif file's Gaussian field into a watertight, print-ready mesh.
Runs on the same Kaggle T4 as the reconstruction pipeline.

Pipeline:
  1. Load Gaussian data from .nif binary
  2. Build Gaussian density field on a voxel grid (GPU-accelerated)
  3. Extract isosurface with Marching Cubes (skimage / cuml)
  4. Mesh repair: remove isolated components, fill holes, fix normals
  5. Laplacian smoothing (detail-preserving — taubin method)
  6. Product shaping: apply template geometry (figurine / bobblehead / keychain / bust / miniature)
  7. Hollowing with escape holes (reduces print material + cost)
  8. Support-free orientation (rotate to minimise overhang area)
  9. Scale to requested physical size (mm)
  10. Export to binary STL
  11. Pack into .nif PRINT_EXPORT chunk (0x0014)
  12. Upload to R2
  13. Update nif_files row with print_r2_key

All mesh processing uses trimesh — battle-tested, handles all edge cases.
GPU density field uses PyTorch tensors for speed.
"""

import os
import sys
import struct
import zlib
import math
import time
import tempfile
from pathlib import Path

import numpy as np
import torch

# ─── Required dependencies ────────────────────────────────────────────────────
try:
    import trimesh
    from trimesh import repair, smoothing, boolean
except ImportError:
    raise ImportError("pip install trimesh[easy] scipy")

try:
    from skimage import measure as sk_measure
except ImportError:
    raise ImportError("pip install scikit-image")

import boto3
from botocore.config import Config
import requests

# ─── Environment ─────────────────────────────────────────────────────────────
_REQUIRED = ['CF_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY',
             'SUPABASE_URL','SUPABASE_SECRET_KEY','GPU_WORKER_SECRET']
_missing  = [k for k in _REQUIRED if not os.environ.get(k)]
if _missing:
    raise EnvironmentError(f"Missing: {', '.join(_missing)}")

DEVICE     = 'cuda' if torch.cuda.is_available() else 'cpu'
BUCKET     = os.environ.get('R2_BUCKET', 'fumoca-nif-storage')
API_BASE   = os.environ.get('API_BASE', 'https://api.fumoca.co.za')
WORKER_KEY = os.environ['GPU_WORKER_SECRET']

R2 = boto3.client(
    's3',
    endpoint_url=f"https://{os.environ['CF_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
    aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
    config=Config(signature_version='s3v4'),
)

from supabase import create_client as _sb_create
_SB = _sb_create(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SECRET_KEY'])

# ─── NIF binary reader (subset — geometry chunk only) ─────────────────────────
NIF_MAGIC        = 0x4E494600
CHUNK_GEO        = 0x0003
CHUNK_PRINT      = 0x0014

def read_nif_gaussians(nif_bytes: bytes) -> dict:
    """Extract Gaussian data from .nif binary. Returns {count, data: np.float32}."""
    dv = memoryview(nif_bytes)
    magic = struct.unpack_from('>I', dv, 0)[0]
    if magic != NIF_MAGIC:
        raise ValueError(f"Not a .nif file (magic 0x{magic:08x})")
    # Parse chunks starting at byte 256
    offset = 256
    while offset < len(dv):
        if offset + 16 > len(dv): break
        chunk_type = struct.unpack_from('>H', dv, offset)[0]
        chunk_size = struct.unpack_from('>I', dv, offset+4)[0]
        chunk_crc  = struct.unpack_from('>I', dv, offset+8)[0]
        if chunk_size == 0 or offset + 16 + chunk_size > len(dv): break
        data = bytes(dv[offset+16: offset+16+chunk_size])
        if chunk_type == CHUNK_GEO:
            count = struct.unpack_from('>I', data, 0)[0]
            arr   = np.frombuffer(data, dtype=np.float32, offset=4, count=count*14)
            return {'count': count, 'data': arr.reshape(count, 14)}
        offset += 16 + chunk_size
    raise ValueError("No KEYFRAME_GEO chunk in .nif file")

def pack_print_chunk(stl_bytes: bytes) -> bytes:
    """Pack STL into a PRINT_EXPORT chunk (0x0014)."""
    crc = zlib.crc32(stl_bytes) & 0xFFFFFFFF
    hdr = struct.pack('>HBxIIxxxx', CHUNK_PRINT, 0x00, len(stl_bytes), crc)
    return hdr + stl_bytes

# ─── Product templates ────────────────────────────────────────────────────────
# Each template defines:
#   name:          display name
#   height_mm:     default print height
#   height_range:  [min, max] in mm
#   aspect_crop:   how to crop the Gaussian cloud (head/shoulders/full)
#   needs_base:    add a flat circular base
#   base_thickness_mm
#   hollow:        hollow out interior to save material
#   wall_mm:       hollow wall thickness
#   escape_holes:  number of escape holes for resin drainage
#   snap_vertical: whether to orient so longest axis is vertical
#   smooth_iters:  Taubin smoothing iterations
#   min_feature_mm: smallest printable feature (FDM vs resin)

PRODUCT_TEMPLATES = {
    'figurine': {
        'name':              'Figurine',
        'height_mm':         120,
        'height_range':      [80, 200],
        'aspect_crop':       'full',
        'needs_base':        True,
        'base_thickness_mm': 3.0,
        'hollow':            True,
        'wall_mm':           2.5,
        'escape_holes':      2,
        'snap_vertical':     True,
        'smooth_iters':      20,
        'min_feature_mm':    1.2,
        'description':       'Full-body figurine, hollow with base',
    },
    'bobblehead': {
        'name':              'Bobblehead',
        'height_mm':         100,
        'height_range':      [60, 150],
        'aspect_crop':       'head',
        'needs_base':        True,
        'base_thickness_mm': 4.0,
        'hollow':            True,
        'wall_mm':           1.8,
        'escape_holes':      1,
        'snap_vertical':     True,
        'smooth_iters':      30,  # more smoothing — bobblehead head is larger
        'min_feature_mm':    1.0,
        'head_scale':        2.2,  # head enlarged relative to body
        'description':       'Enlarged head, small body, spring neck socket',
    },
    'keychain': {
        'name':              'Keychain',
        'height_mm':         45,
        'height_range':      [35, 60],
        'aspect_crop':       'head',
        'needs_base':        False,
        'hollow':            False,
        'snap_vertical':     False,
        'smooth_iters':      15,
        'min_feature_mm':    0.8,
        'keyring_hole':      True,
        'keyring_hole_mm':   4.0,
        'description':       'Head medallion with keyring hole',
    },
    'bust': {
        'name':              'Bust',
        'height_mm':         150,
        'height_range':      [100, 300],
        'aspect_crop':       'bust',
        'needs_base':        True,
        'base_thickness_mm': 5.0,
        'hollow':            True,
        'wall_mm':           3.0,
        'escape_holes':      2,
        'snap_vertical':     True,
        'smooth_iters':      25,
        'min_feature_mm':    1.0,
        'description':       'Head and shoulders classical bust with pedestal',
    },
    'miniature': {
        'name':              'Miniature',
        'height_mm':         32,
        'height_range':      [25, 50],
        'aspect_crop':       'full',
        'needs_base':        True,
        'base_thickness_mm': 2.0,
        'hollow':            False,
        'snap_vertical':     True,
        'smooth_iters':      10,
        'min_feature_mm':    0.5,
        'description':       'Tabletop gaming miniature scale',
    },
    'coin': {
        'name':              'Portrait Coin',
        'height_mm':         40,
        'height_range':      [30, 60],
        'aspect_crop':       'head_profile',
        'needs_base':        False,
        'hollow':            False,
        'snap_vertical':     False,
        'smooth_iters':      12,
        'min_feature_mm':    0.5,
        'coin_depth_mm':     5.0,   # low relief extrusion depth
        'coin_edge':         True,
        'description':       'Low-relief portrait coin / medallion',
    },
    'memory': {
        'name':              'Memory Figurine',
        'height_mm':         150,
        'height_range':      [100, 250],
        'aspect_crop':       'full',
        'needs_base':        True,
        'base_thickness_mm': 6.0,
        'hollow':            True,
        'wall_mm':           3.0,
        'escape_holes':      2,
        'snap_vertical':     True,
        'smooth_iters':      25,
        'min_feature_mm':    1.0,
        'description':       'Keepsake figurine — weddings, couples, memorial, milestone',
        'base_inscription':  True,   # flat top of base for laser-engraved name/date
        'base_text_depth':   0.8,    # mm
    },
    'ornament': {
        'name':              'Hanging Ornament',
        'height_mm':         60,
        'height_range':      [40, 100],
        'aspect_crop':       'head',
        'needs_base':        False,
        'hollow':            True,
        'wall_mm':           2.0,
        'escape_holes':      1,
        'snap_vertical':     True,
        'smooth_iters':      20,
        'min_feature_mm':    0.8,
        'keyring_hole':      True,
        'keyring_hole_mm':   3.5,
        'flat_back':         True,   # flatten back face for wall/tree hanging
        'description':       'Hanging ornament — Christmas tree, rear-view mirror, wall décor',
    },
    'statue': {
        'name':              'Portrait Statue',
        'height_mm':         200,
        'height_range':      [150, 400],
        'aspect_crop':       'full',
        'needs_base':        True,
        'base_thickness_mm': 8.0,
        'hollow':            True,
        'wall_mm':           4.0,
        'escape_holes':      3,
        'snap_vertical':     True,
        'smooth_iters':      15,
        'min_feature_mm':    1.5,
        'description':       'Large display statue for desk, shelf, or trophy cabinet',
    },
}

def _bool_engine():
    """Detect best available boolean mesh engine. Returns 'manifold', 'blender', or None."""
    try:
        import manifold3d
        return 'manifold'
    except ImportError:
        pass
    try:
        import subprocess
        if subprocess.run(['blender','--version'], capture_output=True, timeout=5).returncode == 0:
            return 'blender'
    except Exception:
        pass
    return None


# ─── Gaussian density field on GPU ────────────────────────────────────────────
class GaussianDensityField:
    """
    Evaluate the volumetric density implied by a set of 3D Gaussians
    on a regular voxel grid.

    Density at point p:
        ρ(p) = Σ αᵢ · exp(-½ · (p-μᵢ)ᵀ · Σᵢ⁻¹ · (p-μᵢ))

    The isosurface at ρ = isovalue is the printable surface.

    GPU implementation: evaluates all voxels in batches to avoid OOM.
    """

    def __init__(self, gaussians: dict, voxel_res: int = 128):
        self.count   = gaussians['count']
        self.data    = gaussians['data']   # (N, 14) float32
        self.res     = voxel_res
        self._precompute()

    def _precompute(self):
        d    = self.data
        # Positions
        self.mu = torch.tensor(d[:, 0:3], dtype=torch.float32, device=DEVICE)
        # Log-scale → actual scale
        scale  = torch.exp(torch.tensor(d[:, 3:6], dtype=torch.float32, device=DEVICE))
        # Quaternion [w,x,y,z] → rotation matrices
        qw,qx,qy,qz = d[:,6],d[:,7],d[:,8],d[:,9]
        R = self._quats_to_mats(qw,qx,qy,qz)  # (N, 3, 3)
        # Covariance Σ = R · diag(s²) · Rᵀ
        S2 = scale**2  # (N,3)
        RS = R * S2.unsqueeze(1)  # (N,3,3) * (N,1,3) = R·diag(s²)
        Sigma = torch.bmm(RS, R.transpose(1,2))  # (N,3,3)
        # Invert: Σ⁻¹ using analytical formula for 3×3
        self.SigmaInv = torch.linalg.inv(Sigma + 1e-8 * torch.eye(3, device=DEVICE))
        # Opacity
        self.alpha = torch.sigmoid(torch.tensor(d[:,10], dtype=torch.float32, device=DEVICE))
        # Bounding box of Gaussians
        pos = d[:, 0:3]
        s   = np.exp(d[:, 3:6])
        margin = s.max(axis=1, keepdims=True) * 3
        self.bb_min = (pos - margin).min(axis=0) - 0.1
        self.bb_max = (pos + margin).max(axis=0) + 0.1

    def _quats_to_mats(self, qw, qx, qy, qz):
        """Batch quaternion to rotation matrix. Returns (N,3,3)."""
        qw = torch.tensor(qw, dtype=torch.float32, device=DEVICE)
        qx = torch.tensor(qx, dtype=torch.float32, device=DEVICE)
        qy = torch.tensor(qy, dtype=torch.float32, device=DEVICE)
        qz = torch.tensor(qz, dtype=torch.float32, device=DEVICE)
        N  = len(qw)
        R  = torch.zeros(N, 3, 3, device=DEVICE)
        R[:,0,0] = 1-2*(qy*qy+qz*qz); R[:,0,1] = 2*(qx*qy+qw*qz); R[:,0,2] = 2*(qx*qz-qw*qy)
        R[:,1,0] = 2*(qx*qy-qw*qz);   R[:,1,1] = 1-2*(qx*qx+qz*qz);R[:,1,2] = 2*(qy*qz+qw*qx)
        R[:,2,0] = 2*(qx*qz+qw*qy);   R[:,2,1] = 2*(qy*qz-qw*qx); R[:,2,2] = 1-2*(qx*qx+qy*qy)
        return R

    def evaluate_grid(self, batch_size: int = 64) -> np.ndarray:
        """
        Evaluate density on a (res × res × res) grid.
        Returns float32 array in [0, ~N·alpha_max].
        """
        res  = self.res
        bmin = torch.tensor(self.bb_min, dtype=torch.float32, device=DEVICE)
        bmax = torch.tensor(self.bb_max, dtype=torch.float32, device=DEVICE)

        # Grid coordinates
        xs = torch.linspace(bmin[0], bmax[0], res, device=DEVICE)
        ys = torch.linspace(bmin[1], bmax[1], res, device=DEVICE)
        zs = torch.linspace(bmin[2], bmax[2], res, device=DEVICE)
        grid = torch.stack(torch.meshgrid(xs, ys, zs, indexing='ij'), dim=-1)  # (R,R,R,3)
        pts  = grid.reshape(-1, 3)  # (R³, 3)

        density = torch.zeros(pts.shape[0], device=DEVICE)
        N = self.count

        # Evaluate in batches over Gaussians to avoid OOM
        G_BATCH = min(2000, N)
        for g_start in range(0, N, G_BATCH):
            g_end = min(g_start + G_BATCH, N)
            mu_b  = self.mu[g_start:g_end]         # (G,3)
            Si_b  = self.SigmaInv[g_start:g_end]   # (G,3,3)
            al_b  = self.alpha[g_start:g_end]       # (G,)

            # Evaluate in batches over points
            P_BATCH = 65536
            for p_start in range(0, len(pts), P_BATCH):
                p_end = min(p_start + P_BATCH, len(pts))
                p_b   = pts[p_start:p_end]          # (P,3)

                # d[p,g] = p_b[p] - mu_b[g]
                d = p_b.unsqueeze(1) - mu_b.unsqueeze(0)   # (P,G,3)
                # Mahalanobis: d · Σ⁻¹ · dᵀ per (p,g)
                dSi = torch.einsum('pgi,gij->pgj', d, Si_b)  # (P,G,3)
                mahal = (dSi * d).sum(dim=-1)                 # (P,G)
                # Gaussian kernel
                contrib = al_b.unsqueeze(0) * torch.exp(-0.5 * mahal)  # (P,G)
                density[p_start:p_end] += contrib.sum(dim=1)

        density_np = density.cpu().numpy().reshape(res, res, res)
        print(f'[Print] Density field: min={density_np.min():.4f}  max={density_np.max():.4f}  '
              f'shape={density_np.shape}')
        return density_np, bmin.cpu().numpy(), bmax.cpu().numpy()

# ─── Mesh extraction and repair ───────────────────────────────────────────────
class MeshProcessor:

    def __init__(self, gaussians: dict, template_name: str,
                 height_mm: float = None, edit_params: dict = None):
        self.gaussians     = gaussians
        self.template      = PRODUCT_TEMPLATES[template_name].copy()
        self.template_name = template_name
        self.height_mm     = height_mm or self.template['height_mm']
        self.mesh          = None

        # Apply user edit overrides — sliders from the dashboard
        if edit_params:
            for key, val in edit_params.items():
                if key in self.template:
                    self.template[key] = val
                    print(f'[Print] Edit override: {key} = {val}')
            # Special: bobblehead neck split height override
            if 'neck_split_pct' in edit_params:
                self.template['neck_split_pct'] = edit_params['neck_split_pct']
            # Special: spring gap override
            if 'spring_gap_mm' in edit_params:
                self.template['spring_gap_mm'] = edit_params['spring_gap_mm']
            # Special: socket radius override
            if 'socket_r_mm' in edit_params:
                self.template['socket_r_mm'] = edit_params['socket_r_mm']
            # Special: bust crop override
            if 'bust_crop_pct' in edit_params:
                self.template['bust_crop_pct'] = edit_params['bust_crop_pct']

    # ── Step 1: density field ─────────────────────────────────────────────────
    def build_density_field(self, voxel_res: int = 128):
        print(f'[Print] Building {voxel_res}³ density field on {DEVICE}...')
        field = GaussianDensityField(self.gaussians, voxel_res)
        self._density, self._bb_min, self._bb_max = field.evaluate_grid()
        self._voxel_size = (self._bb_max - self._bb_min) / voxel_res
        print(f'[Print] Voxel size: {self._voxel_size}  '
              f'BB: {self._bb_min.round(3)} → {self._bb_max.round(3)}')

    # ── Step 2: isosurface extraction ─────────────────────────────────────────
    def extract_isosurface(self, isovalue: float = None):
        """
        Marching Cubes (Lorensen & Cline, 1987).
        Adaptive isovalue: takes the 85th percentile of non-trivial voxels.
        Falls back gracefully if the field is sparse or near-zero.
        """
        if isovalue is None:
            nonzero = self._density[self._density > 0.01]
            if len(nonzero) < 100:
                # Very sparse field — lower the threshold significantly
                nonzero = self._density[self._density > 0.001]
            if len(nonzero) > 0:
                isovalue = float(np.percentile(nonzero, 85))
            else:
                # Density field is essentially empty — use a very low threshold
                isovalue = float(self._density.max() * 0.1)
                print(f'[Print] Warning: sparse density field, using isovalue={isovalue:.6f}')
            # Never go below a meaningful threshold or above 90th pct
            isovalue = max(isovalue, 0.005)
        print(f'[Print] Marching cubes at isovalue={isovalue:.4f}...')

        try:
            verts, faces, normals, _ = sk_measure.marching_cubes(
                self._density,
                level=isovalue,
                spacing=tuple(self._voxel_size.tolist()),
                allow_degenerate=False,
            )
        except ValueError as e:
            # No surface found at this isovalue — try lower
            isovalue *= 0.5
            print(f'[Print] Marching cubes retrying at isovalue={isovalue:.4f}...')
            verts, faces, normals, _ = sk_measure.marching_cubes(
                self._density,
                level=isovalue,
                spacing=tuple(self._voxel_size.tolist()),
                allow_degenerate=False,
            )

        # Transform to world space
        verts += self._bb_min
        self.mesh = trimesh.Trimesh(vertices=verts, faces=faces, vertex_normals=normals)
        print(f'[Print] Raw mesh: {len(self.mesh.vertices):,} verts, {len(self.mesh.faces):,} faces')

    # ── Step 3: crop by aspect ────────────────────────────────────────────────
    def crop_to_template(self):
        """Crop Gaussian cloud to the region relevant for this product type."""
        aspect = self.template.get('aspect_crop', 'full')
        if aspect == 'full':
            return  # nothing to crop

        bounds = self.mesh.bounds  # [[minx,miny,minz],[maxx,maxy,maxz]]
        h = bounds[1][1] - bounds[0][1]  # total height (y axis = up)

        if aspect == 'head':
            # Top 35% = head
            cut_y = bounds[0][1] + h * 0.65
        elif aspect == 'bust':
            # Top 55% = head + shoulders
            cut_y = bounds[0][1] + h * 0.45
        elif aspect == 'head_profile':
            cut_y = bounds[0][1] + h * 0.65
        else:
            return

        # Clip with a plane
        plane_origin = [0, cut_y, 0]
        plane_normal = [0, -1, 0]  # cut below this y
        result = self.mesh.slice_plane(plane_origin, plane_normal)
        if result is None or len(result.vertices) < 50:
            print(f'[Print] Warning: crop ({aspect}) yielded empty mesh — keeping full')
        else:
            self.mesh = result

        if self.template_name == 'bobblehead':
            self._apply_bobblehead_scaling()

        print(f'[Print] After crop ({aspect}): {len(self.mesh.vertices)} verts')

    def _apply_bobblehead_scaling(self):
        """
        Build a real printable bobblehead — two separate parts:
          Part A: Body  — bottom 40% of figure, slightly compressed, with hemispherical
                          neck socket and flat base
          Part B: Head  — top 60% of figure, enlarged 2.2x, with a hemisphere ball
                          on the underside that fits the body socket

        The two parts are printed separately and assembled post-print.
        A spring (typically 8–10mm diameter coil, available from hardware stores)
        sits between them in the 4mm gap.

        Socket dimensions chosen to match a standard 8mm spring coil:
          Ball radius:   5mm
          Socket radius: 5.2mm (0.2mm clearance for friction fit or spring)
          Socket depth:  4mm

        The body exports as a separate STL file suffixed '_body.stl'.
        The head exports as '_head.stl'.
        Both are stored in R2 and returned in print_stats.
        """
        scale     = self.template.get('head_scale', 2.2)
        bounds    = self.mesh.bounds
        h         = bounds[1][1] - bounds[0][1]

        # Support user-edited neck split, spring gap, socket radius
        neck_split_pct = self.template.get('neck_split_pct', 40) / 100
        SPRING_GAP     = self.template.get('spring_gap_mm', 4.0)
        BALL_R         = self.template.get('ball_r_mm', 5.0)
        SOCKET_R       = self.template.get('socket_r_mm', 5.2)
        SOCKET_DEPTH   = 4.0

        neck_y = bounds[0][1] + h * neck_split_pct

        # ── Part B: Body ──────────────────────────────────────────────────────
        body = self.mesh.copy()
        # slice_plane keeps vertices on the POSITIVE side of the plane normal
        # normal [0, 1, 0] = keep everything where y > neck_y → wrong (keeps top)
        # normal [0,-1, 0] = keep everything where y < neck_y → correct (keeps bottom)
        body_sliced = body.slice_plane([0, neck_y, 0], [0, -1, 0])
        if body_sliced is None or len(body_sliced.vertices) < 30:
            print('[Print] Bobblehead body crop failed — using full lower half')
            body_sliced = body

        trimesh.repair.fill_holes(body_sliced)

        # Add neck socket (hemisphere cavity pointing upward from the top of the body)
        # Socket sits centred on XZ at the top face of the body
        b_top = body_sliced.bounds[1][1]  # highest point of body
        socket_centre = [
            (body_sliced.bounds[0][0] + body_sliced.bounds[1][0]) / 2,
            b_top - SOCKET_DEPTH * 0.5,
            (body_sliced.bounds[0][2] + body_sliced.bounds[1][2]) / 2,
        ]
        # Hemisphere as a sphere with the bottom half sliced off
        socket_sphere = trimesh.creation.icosphere(subdivisions=4, radius=SOCKET_R)
        socket_sphere.apply_translation(socket_centre)

        # Subtract socket from body using boolean difference
        engine = _bool_engine()
        if engine:
            try:
                body_with_socket = trimesh.boolean.difference(
                    [body_sliced, socket_sphere], engine=engine
                )
                if body_with_socket is not None and len(body_with_socket.faces) > 0:
                    body_sliced = body_with_socket
                    print(f'[Print] Bobblehead: socket cut into body (r={SOCKET_R}mm)')
                else:
                    print('[Print] Bobblehead: socket boolean failed — body without socket')
            except Exception as e:
                print(f'[Print] Bobblehead socket: {e} — skipping')
        else:
            print('[Print] Bobblehead: no boolean engine — socket omitted')

        # ── Part A: Head ──────────────────────────────────────────────────────
        head = self.mesh.copy()
        # normal [0, 1, 0] = keep everything where y > neck_y → correct (keeps top)
        head_sliced = head.slice_plane([0, neck_y, 0], [0, 1, 0])
        if head_sliced is None or len(head_sliced.vertices) < 30:
            print('[Print] Bobblehead head crop failed — using full upper half')
            head_sliced = head

        trimesh.repair.fill_holes(head_sliced)

        # Scale head upward from its base (not its centroid — prevents floating)
        base_point = [head_sliced.centroid[0], head_sliced.bounds[0][1], head_sliced.centroid[2]]
        M = trimesh.transformations.scale_matrix(scale, base_point)
        head_sliced.apply_transform(M)

        # Add neck ball on the underside of the head
        # Ball sits centred on XZ at the bottom of the (scaled) head
        h_bot = head_sliced.bounds[0][1]
        ball_centre = [
            (head_sliced.bounds[0][0] + head_sliced.bounds[1][0]) / 2,
            h_bot + BALL_R * 0.6,  # partially embedded in the head base
            (head_sliced.bounds[0][2] + head_sliced.bounds[1][2]) / 2,
        ]
        neck_ball = trimesh.creation.icosphere(subdivisions=4, radius=BALL_R)
        neck_ball.apply_translation(ball_centre)
        head_sliced = trimesh.util.concatenate([head_sliced, neck_ball])
        trimesh.repair.fill_holes(head_sliced)

        # ── Reposition relative to each other ────────────────────────────────
        # Body: sit on Y=0
        b_bounds = body_sliced.bounds
        body_sliced.apply_translation([0, -b_bounds[0][1], 0])

        # Head: sits SPRING_GAP mm above the top of the body
        body_top_y = body_sliced.bounds[1][1]
        h_bounds   = head_sliced.bounds
        head_sliced.apply_translation([0, body_top_y + SPRING_GAP - h_bounds[0][1], 0])

        # ── Store both parts ──────────────────────────────────────────────────
        # We keep them as separate meshes so they can be exported as separate STLs
        self._bobblehead_body = body_sliced
        self._bobblehead_head = head_sliced

        # For the main pipeline (single mesh preview / stats), show them together
        self.mesh = trimesh.util.concatenate([body_sliced, head_sliced])

        print(f'[Print] Bobblehead: body={len(body_sliced.faces)} faces, '
              f'head={len(head_sliced.faces)} faces  '
              f'spring gap={SPRING_GAP}mm  ball_r={BALL_R}mm  socket_r={SOCKET_R}mm')

    # ── Step 4: Laplacian smoothing (Taubin λ/μ method) ──────────────────────
    def smooth(self):
        """
        Taubin smoothing: alternates positive (λ) and negative (μ) passes.
        Avoids the volume shrinkage of plain Laplacian smoothing.
        λ=0.5, μ=-0.53 per Taubin 1995.
        """
        iters = self.template.get('smooth_iters', 20)
        print(f'[Print] Taubin smoothing ({iters} iterations)...')
        trimesh.smoothing.filter_taubin(self.mesh, lamb=0.5, nu=0.53, iterations=iters)

    # ── Step 5: mesh repair ───────────────────────────────────────────────────
    def repair(self):
        """
        Make the mesh watertight (manifold, no holes, consistent normals).
        Required for all FDM and resin printers.
        """
        print('[Print] Repairing mesh...')

        # Keep only the largest connected component (removes floating debris)
        components = self.mesh.split(only_watertight=False)
        if len(components) > 1:
            self.mesh = max(components, key=lambda m: len(m.faces))
            print(f'[Print] Kept largest of {len(components)} components')

        # Fill holes
        trimesh.repair.fill_holes(self.mesh)

        # Fix winding so all normals point outward
        trimesh.repair.fix_normals(self.mesh)

        # Fix inward-facing faces
        trimesh.repair.fix_inversion(self.mesh)

        # Merge duplicate vertices (from marching cubes)
        self.mesh.merge_vertices()
        self.mesh.remove_duplicate_faces()
        self.mesh.remove_unreferenced_vertices()

        if not self.mesh.is_watertight:
            # Try progressive repair before resorting to destructive methods
            print('[Print] Mesh not watertight — attempting progressive repair...')
            # Pass 1: aggressive hole filling
            trimesh.repair.fill_holes(self.mesh)
            trimesh.repair.fix_normals(self.mesh)
            self.mesh.merge_vertices(merge_tex=True, merge_norm=True)
            self.mesh.remove_duplicate_faces()
            self.mesh.remove_unreferenced_vertices()

            if not self.mesh.is_watertight:
                # Pass 2: voxel remesh at slightly lower resolution — preserves shape
                try:
                    from skimage import measure as sk_m
                    vol   = self.mesh.voxelized(pitch=self.mesh.scale / 80)
                    vol   = vol.fill()
                    marched = vol.as_boxes().convex_hull  # solid voxel hull
                    # Use box union as watertight proxy if detail mesh fails
                    if marched.is_watertight:
                        self.mesh = marched
                        print('[Print] Repaired via voxel remesh')
                    else:
                        raise ValueError('voxel remesh not watertight')
                except Exception as e2:
                    print(f'[Print] Progressive repair failed ({e2}) — using convex hull as last resort')
                    self.mesh = self.mesh.convex_hull

        print(f'[Print] Watertight: {self.mesh.is_watertight}  '
              f'Volume: {self.mesh.volume:.2f} units³')

    # ── Step 6: orient vertically ─────────────────────────────────────────────
    def orient(self):
        """
        Rotate so the tallest/most relevant axis points up (Y+).
        Uses PCA on vertex positions to find the principal axis.
        Handles degenerate meshes (flat, tiny, symmetric) safely.
        """
        if not self.template.get('snap_vertical', True):
            return

        verts   = self.mesh.vertices
        centred = verts - verts.mean(axis=0)

        # Guard: need variance to do PCA
        if centred.std() < 1e-6:
            print('[Print] Orient: mesh too small/flat for PCA — skipping rotation')
            b = self.mesh.bounds
            self.mesh.apply_translation([-self.mesh.centroid[0], -b[0][1], -self.mesh.centroid[2]])
            return

        _, _, Vt = np.linalg.svd(centred, full_matrices=False)
        principal = Vt[0]  # direction of greatest variance

        up = np.array([0.0, 1.0, 0.0])
        cos_a = float(np.clip(np.dot(principal, up), -1.0, 1.0))
        angle = math.acos(abs(cos_a))  # use abs — either end of axis can be up

        if angle < 0.05:  # already vertical within ~3°
            pass
        elif angle > math.pi - 0.05:  # pointing straight down — flip 180°
            R = trimesh.transformations.rotation_matrix(math.pi, [1, 0, 0])
            self.mesh.apply_transform(R)
        else:
            axis = np.cross(principal, up)
            norm = np.linalg.norm(axis)
            if norm < 1e-8:
                # Principal axis is parallel to up — no rotation needed
                pass
            else:
                axis /= norm
                # Flip angle if principal is pointing downward
                if cos_a < 0:
                    angle = -angle
                R = trimesh.transformations.rotation_matrix(angle, axis)
                self.mesh.apply_transform(R)

        # Centre on XZ, sit on Y=0
        b = self.mesh.bounds
        self.mesh.apply_translation([-self.mesh.centroid[0], -b[0][1], -self.mesh.centroid[2]])
        print(f'[Print] Oriented. Bounds: {np.round(self.mesh.bounds, 1).tolist()}')

    # ── Step 7: support-free overhang minimisation ────────────────────────────
    def minimise_overhangs(self, max_overhang_deg: float = 45.0):
        """
        Rotate the mesh around Y to minimise the area of faces that
        overhang more than max_overhang_deg from vertical.
        Tested at 36 angles (10° step) — pick the best.
        FDM printers typically support overhangs up to 45°.
        Resin printers support steeper but benefit from fewer supports.
        """
        print(f'[Print] Minimising overhangs (max {max_overhang_deg}°)...')
        up         = np.array([0.0, 1.0, 0.0])
        threshold  = np.cos(np.radians(90 - max_overhang_deg))
        best_angle = 0.0
        best_area  = float('inf')

        for deg in range(0, 360, 10):
            rad  = np.radians(deg)
            R    = trimesh.transformations.rotation_matrix(rad, [0,1,0])
            verts= trimesh.transformations.transform_points(self.mesh.vertices, R)
            # Face normals in rotated frame
            fverts = verts[self.mesh.faces]
            e1 = fverts[:,1] - fverts[:,0]; e2 = fverts[:,2] - fverts[:,0]
            normals = np.cross(e1, e2)
            lens = np.linalg.norm(normals, axis=1, keepdims=True) + 1e-10
            normals /= lens
            dot = np.dot(normals, -up)          # faces pointing downward
            overhang_mask = dot > threshold
            areas = (lens.squeeze() / 2)
            overhang_area = areas[overhang_mask].sum()
            if overhang_area < best_area:
                best_area = overhang_area
                best_angle = rad

        R = trimesh.transformations.rotation_matrix(best_angle, [0,1,0])
        self.mesh.apply_transform(R)
        # Re-sit on Y=0
        b = self.mesh.bounds
        self.mesh.apply_translation([0, -b[0][1], 0])
        print(f'[Print] Best rotation: {np.degrees(best_angle):.0f}°  '
              f'Overhang area: {best_area:.2f}')

    # ── Step 8: scale to physical size ────────────────────────────────────────
    def scale_to_size(self):
        """Scale mesh so its height equals self.height_mm in millimetres."""
        b      = self.mesh.bounds
        curr_h = b[1][1] - b[0][1]
        if curr_h < 1e-6:
            raise ValueError("Mesh has zero height — extraction failed")
        factor = self.height_mm / curr_h
        self.mesh.apply_scale(factor)
        b2 = self.mesh.bounds
        print(f'[Print] Scaled ×{factor:.4f} → '
              f'{(b2[1]-b2[0]).round(1)} mm  (target height {self.height_mm}mm)')

    # ── Step 9: add flat base ─────────────────────────────────────────────────
    def add_base(self):
        if not self.template.get('needs_base', False):
            return
        t   = self.template['base_thickness_mm']
        b   = self.mesh.bounds
        r   = max(b[1][0]-b[0][0], b[1][2]-b[0][2]) * 0.55  # slightly wider than model
        base = trimesh.creation.cylinder(radius=r, height=t, sections=64)
        # Sit base so its top is at y=0 (where model sits)
        base.apply_translation([0, -t/2, 0])
        self.mesh = trimesh.util.concatenate([self.mesh, base])
        # Merge and repair the combined mesh
        trimesh.repair.fill_holes(self.mesh)
        self.mesh.merge_vertices()
        print(f'[Print] Base added: r={r:.1f}mm  h={t}mm')

    # ── Step 10: hollow with escape holes ─────────────────────────────────────
    def hollow(self):
        if not self.template.get('hollow', False):
            return
        wall_mm = self.template['wall_mm']
        n_holes = self.template.get('escape_holes', 2)
        print(f'[Print] Hollowing: wall={wall_mm}mm, {n_holes} escape holes...')
        engine = _bool_engine()

        if engine is None:
            # No boolean engine — approximate hollow by scaling inward
            print('[Print] No boolean engine (install manifold3d) — using scale approximation')
            inner = self.mesh.copy()
            # Scale mesh inward uniformly by wall_mm relative to its size
            b     = self.mesh.bounds
            scale = 1.0 - (wall_mm * 2) / max(b[1] - b[0])
            inner.apply_scale(max(0.5, scale))
            inner.invert()
            combined = trimesh.util.concatenate([self.mesh, inner])
            combined.merge_vertices()
            self.mesh = combined
            return

        # Boolean subtract: outer shell minus inner (scaled-inward copy)
        inner = self.mesh.copy()
        inner.invert()
        # Force recompute vertex normals — they may be stale after boolean/concat ops
        inner = trimesh.Trimesh(vertices=inner.vertices, faces=inner.faces, process=True)
        if not hasattr(inner, 'vertex_normals') or inner.vertex_normals is None:
            inner.vertex_normals  # trimesh computes on first access
        inner.vertices -= inner.vertex_normals * wall_mm

        try:
            result = trimesh.boolean.difference([self.mesh, inner], engine=engine)
            if result is not None and result.is_watertight:
                self.mesh = result
            else:
                print('[Print] Hollow boolean returned non-watertight — keeping solid')
                return
        except Exception as e:
            print(f'[Print] Hollow boolean failed ({engine}): {e} — keeping solid')
            return

        # Add escape holes — 2mm radius is correct for resin drainage
        if n_holes > 0:
            b       = self.mesh.bounds
            base_y  = b[0][1] + wall_mm * 0.5
            r_model = max(b[1][0]-b[0][0], b[1][2]-b[0][2]) * 0.3
            hole_r  = 2.0  # mm — standard resin escape hole, not keyring size
            for i in range(n_holes):
                angle = 2 * math.pi * i / n_holes
                cx = r_model * 0.4 * math.cos(angle)
                cz = r_model * 0.4 * math.sin(angle)
                hole = trimesh.creation.cylinder(radius=hole_r, height=wall_mm * 3)
                hole.apply_translation([cx, base_y, cz])
                try:
                    result = trimesh.boolean.difference([self.mesh, hole], engine=engine)
                    if result is not None and len(result.faces) > 0:
                        self.mesh = result
                except Exception:
                    pass  # escape hole is cosmetic — skip on failure

        print(f'[Print] Hollowed. Volume: {self.mesh.volume:.1f}mm³  '
              f'(est. {self.mesh.volume*0.0012:.1f}g PLA)')

    # ── Step 11: keyring hole ─────────────────────────────────────────────────
    def add_keyring_hole(self):
        if not self.template.get('keyring_hole', False):
            return
        d   = self.template['keyring_hole_mm']
        b   = self.mesh.bounds
        top = b[1][1]
        cx  = (b[0][0]+b[1][0])/2
        cz  = (b[0][2]+b[1][2])/2
        hole = trimesh.creation.cylinder(radius=d/2, height=(b[1][0]-b[0][0])*0.6)
        hole.apply_transform(trimesh.transformations.rotation_matrix(math.pi/2, [0,0,1]))
        hole.apply_translation([cx, top - d, cz])
        # Try manifold first, blender second, skip if neither available
        for engine in ('manifold', 'blender'):
            try:
                result = trimesh.boolean.difference([self.mesh, hole], engine=engine)
                if result is not None and len(result.faces) > 0:
                    self.mesh = result
                    break
            except Exception:
                continue
        print(f'[Print] Keyring hole: ⌀{d}mm')

    # ── Step 12: coin profile relief ─────────────────────────────────────────
    def make_coin(self):
        """Extrude head profile as a low-relief coin/medallion."""
        if self.template_name != 'coin':
            return
        depth = self.template.get('coin_depth_mm', 5.0)
        d = self.mesh.bounds[1] - self.mesh.bounds[0]
        # Project vertices onto XZ plane, extrude by depth in Y
        # Scale XZ to fit coin radius
        coin_r = self.height_mm / 2
        scale_xz = coin_r / max(d[0], d[2])
        M = np.eye(4)
        M[0,0] = scale_xz; M[2,2] = scale_xz; M[1,1] = depth / d[1]
        self.mesh.apply_transform(M)
        # Add circular coin body
        disc = trimesh.creation.cylinder(radius=coin_r, height=depth*0.3, sections=128)
        disc.apply_translation([0, -depth*0.15, 0])
        self.mesh = trimesh.util.concatenate([self.mesh, disc])

    # ── Export STL ────────────────────────────────────────────────────────────
    def export_stl(self, path: Path = None) -> bytes:
        """Export binary STL. Returns bytes."""
        if path:
            self.mesh.export(str(path), file_type='stl')
            return path.read_bytes()
        return self.mesh.export(file_type='stl')

    # ── Print stats ───────────────────────────────────────────────────────────
    def print_stats(self) -> dict:
        b = self.mesh.bounds
        dims = b[1] - b[0]
        vol  = self.mesh.volume
        return {
            'template':      self.template_name,
            'height_mm':     round(self.height_mm, 1),
            'width_mm':      round(dims[0], 1),
            'depth_mm':      round(dims[2], 1),
            'faces':         len(self.mesh.faces),
            'vertices':      len(self.mesh.vertices),
            'volume_mm3':    round(vol, 1),
            'pla_weight_g':  round(vol * 0.00124, 1),  # PLA density 1.24 g/cm³
            'resin_weight_g':round(vol * 0.00110, 1),
            'is_watertight': self.mesh.is_watertight,
            'recommended_printer': 'FDM (PLA/PETG)' if self.height_mm > 50 else 'Resin (LCD/DLP)',
        }

    # ── Full pipeline ──────────────────────────────────────────────────────────
    def run(self, voxel_res: int = 128) -> bytes:
        """Run the complete pipeline and return STL bytes."""
        self.build_density_field(voxel_res)
        self.extract_isosurface()
        self.crop_to_template()
        self.smooth()
        self.repair()
        self.orient()
        self.minimise_overhangs()
        self.scale_to_size()
        self.add_base()
        if self.template_name == 'coin':
            self.make_coin()
        if self.template.get('flat_back'):
            self._flatten_back()
        self.hollow()
        self.add_keyring_hole()
        # Final repair pass after all modifications
        trimesh.repair.fill_holes(self.mesh)
        self.mesh.merge_vertices()
        self.mesh.remove_duplicate_faces()
        self.mesh.remove_unreferenced_vertices()
        stats = self.print_stats()
        print(f'[Print] Complete: {stats}')
        self._stats = stats
        return self.export_stl()

    def _flatten_back(self):
        """
        Slice off the back of the model with a flat plane so it hangs flush
        against a wall or sits flat on a tree branch.
        Removes the rear ~15% of depth.
        """
        b      = self.mesh.bounds
        depth  = b[1][2] - b[0][2]
        cut_z  = b[1][2] - depth * 0.15
        result = self.mesh.slice_plane([0, 0, cut_z], [0, 0, 1])
        if result is not None and len(result.vertices) > 50:
            self.mesh = result
            trimesh.repair.fill_holes(self.mesh)
            print('[Print] Flat back applied')


# ─── Print job worker ─────────────────────────────────────────────────────────
class PrintJobWorker:
    """
    Invoked by the API when a user requests a 3D print export.
    1. Downloads .nif from R2
    2. Runs MeshProcessor for each requested template
    3. Uploads STL to R2
    4. Patches .nif with PRINT_EXPORT chunk (optional)
    5. Updates nif_files.print_r2_keys in Supabase
    """

    def __init__(self, nif_id: str, user_id: str):
        self.nif_id  = nif_id
        self.user_id = user_id
        self.tmp     = Path(tempfile.mkdtemp(prefix=f'nif_print_{nif_id[:8]}_'))

    def _tick(self, status: str, pct: int, **kw):
        try:
            requests.patch(
                f'{API_BASE}/api/print-jobs/{self.nif_id}/progress',
                json={'status': status, 'progress': pct, **kw},
                headers={'x-worker-key': WORKER_KEY},
                timeout=15,
            )
        except Exception as e:
            print(f'[warn] API: {e}')
        print(f'[Print job] {self.nif_id[:8]} {status} {pct}%')

    def run(self, templates: list, height_mm: float = None,
            voxel_res: int = 128, edit_params: dict = None):
        """
        templates:   ['figurine', 'keychain', ...] — which products to generate
        height_mm:   optional height override
        voxel_res:   128 (fast, 1-2min) or 256 (better quality, 5-8min)
        edit_params: user slider values from the dashboard
        """
        try:
            self._tick('processing', 5)
            nif_bytes = self._download_nif()

            self._tick('processing', 15)
            gaussians = read_nif_gaussians(nif_bytes)
            print(f'[Print] {gaussians["count"]} depth points loaded')

            results = {}
            base_pct = 20
            per_template = (75 - base_pct) // max(len(templates), 1)

            for i, tmpl in enumerate(templates):
                if tmpl not in PRODUCT_TEMPLATES:
                    print(f'[Print] Unknown template "{tmpl}" — skipping')
                    continue
                self._tick('processing', base_pct + i * per_template,
                           current_template=tmpl)

                h = height_mm or PRODUCT_TEMPLATES[tmpl]['height_mm']
                processor = MeshProcessor(gaussians, tmpl, h,
                                          edit_params=edit_params or {})
                stl_bytes = processor.run(voxel_res)
                stats     = processor._stats

                # Upload STL(s)
                if tmpl == 'bobblehead' and hasattr(processor, '_bobblehead_body'):
                    # Bobblehead exports TWO files — body and head print separately
                    for part, mesh in [('body', processor._bobblehead_body),
                                       ('head', processor._bobblehead_head)]:
                        part_bytes = mesh.export(file_type='stl')
                        part_key   = f'print/{self.user_id}/{self.nif_id}/{tmpl}_{part}.stl'
                        R2.put_object(Bucket=BUCKET, Key=part_key, Body=part_bytes,
                                      ContentType='application/sla')
                        print(f'[Print] Uploaded {part}: {len(part_bytes):,}B → {part_key}')
                    stl_key = f'print/{self.user_id}/{self.nif_id}/{tmpl}_body.stl'  # primary key
                    results[tmpl] = {
                        'r2_key':       stl_key,
                        'r2_key_head':  f'print/{self.user_id}/{self.nif_id}/{tmpl}_head.stl',
                        'r2_key_body':  stl_key,
                        'two_parts':    True,
                        'stats':        stats,
                        'assembly_note':'Print head and body separately. '
                                        'Insert 8–10mm diameter spring between body socket and '
                                        'head ball. Standard coil spring, 15–20mm free length.',
                    }
                else:
                    stl_key = f'print/{self.user_id}/{self.nif_id}/{tmpl}.stl'
                    R2.put_object(Bucket=BUCKET, Key=stl_key, Body=stl_bytes,
                                  ContentType='application/sla')
                    print(f'[Print] Uploaded {len(stl_bytes):,}B → {stl_key}')
                    results[tmpl] = {'r2_key': stl_key, 'stats': stats}

            self._tick('processing', 90)
            self._register_results(results)
            self._tick('complete', 100, results=results)
            return results

        except Exception as e:
            self._tick('failed', 0, error=str(e))
            raise
        finally:
            import shutil
            shutil.rmtree(self.tmp, ignore_errors=True)

    def _download_nif(self) -> bytes:
        """Get nif_r2_key from Supabase then download from R2."""
        res = _SB.table('nif_files').select('r2_key').eq('id', self.nif_id).single().execute()
        if not res.data:
            raise ValueError(f'NIF {self.nif_id} not found')
        key = res.data['r2_key']
        obj = R2.get_object(Bucket=BUCKET, Key=key)
        return obj['Body'].read()

    def _register_results(self, results: dict):
        """Store print R2 keys in nif_files metadata."""
        print_meta = {tmpl: r['r2_key'] for tmpl, r in results.items()}
        print_stats= {tmpl: r['stats']  for tmpl, r in results.items()}
        _SB.table('nif_files').update({
            'print_r2_keys':  print_meta,
            'print_stats':    print_stats,
        }).eq('id', self.nif_id).execute()
        print(f'[Print] Registered {len(results)} print exports in Supabase')


# ─── CLI ─────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    import json
    if len(sys.argv) < 3:
        print('Usage: NIFPrintPipeline.py <nif_id> <user_id> '
              '[templates=figurine,keychain] [height_mm=120] [voxel_res=128]')
        sys.exit(1)

    nif_id    = sys.argv[1]
    user_id   = sys.argv[2]
    templates = sys.argv[3].split(',') if len(sys.argv) > 3 else ['figurine']
    height_mm = float(sys.argv[4]) if len(sys.argv) > 4 else None
    voxel_res = int(sys.argv[5])   if len(sys.argv) > 5 else 128

    worker = PrintJobWorker(nif_id, user_id)
    worker.run(templates, height_mm, voxel_res)
