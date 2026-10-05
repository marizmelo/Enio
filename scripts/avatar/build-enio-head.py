# Builds the default Enio head: a CC0 human from MakeHuman assets through
# MPFB, rigged with TalkingHead's Mixamo-compatible rig, with the Meta visemes
# and ARKit face units baked into every part, exported as a GLB the desktop's
# face can wear.
#
#   blender -b -P scripts/avatar/build-enio-head.py -- /path/out.glb
#
# Needs Blender 4.2+ with the MPFB extension installed (Get Extensions, or
# `blender --command extension install-file <mpfb zip> --repo user_default
# --enable`). Everything else -- TalkingHead's rig, weights and target files
# (MIT) and the four MakeHuman asset packs (CC0, ~330 MB) -- is fetched once
# into ~/.enio/avatar/build and MPFB's own data directory.
#
# Why a script and not the add-on's buttons: the default head must be
# reproducible, and its three non-obvious steps (see the comments at
# "materials" and "rest pose") are easy to lose between clicks.
import bpy, sys, os, importlib, importlib.util, urllib.request

CACHE = os.path.join(os.path.expanduser(os.environ.get("ENIO_DATA_DIR", "~/.enio")), "avatar", "build")
OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.path.join(CACHE, "enio-head.glb")
TALKINGHEAD = "https://github.com/met4citizen/TalkingHead/raw/main/blender/MPFB/"
PACKS = [
    "https://files.makehumancommunity.org/functional/visemes02.zip",
    "https://files.makehumancommunity.org/functional/faceunits01.zip",
    "https://files.makehumancommunity.org/asset_packs/system_clothes_materials01/system_clothes_materials01_cc0.zip",
    "https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip",
]

def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f"FETCH {url}", flush=True)
    urllib.request.urlretrieve(url, dest + ".part")
    os.replace(dest + ".part", dest)
    return dest

mod = next((m for n, m in sys.modules.items() if "mpfb" in n.lower() and hasattr(m, "services")), None)
if mod is None:
    raise SystemExit("MPFB is not installed in this Blender. Install the extension first (Edit > Preferences > Get Extensions > MPFB).")
HERE = CACHE
for name in ("talkinghead-addon.py", "talkinghead.mpfbskel", "talkinghead.mhw"):
    fetch(TALKINGHEAD + name, os.path.join(HERE, name))
S = lambda name: importlib.import_module(f"{mod.__name__}.services.{name}")
HumanService = S("humanservice").HumanService
RigService = S("rigservice").RigService
LocationService = S("locationservice").LocationService
TargetService = S("targetservice").TargetService
FaceService = S("faceservice").FaceService
ExportService = S("exportservice").ExportService
ObjectService = S("objectservice").ObjectService
Rig = importlib.import_module(f"{mod.__name__}.entities.rig").Rig
DATA = LocationService.get_user_data()
AssetService = S("assetservice").AssetService
# The asset packs, installed through MPFB's own extractor the first time.
if not os.path.isdir(os.path.join(DATA, "targets", "visemes")) or not os.path.isdir(os.path.join(DATA, "skins", "young_caucasian_male")):
    for url in PACKS:
        zip_path = fetch(url, os.path.join(HERE, "packs", os.path.basename(url)))
        err = AssetService.fix_and_extract_asset_pack_zip(zip_path, DATA)
        print(f"PACK {os.path.basename(url)} -> {err or 'ok'}", flush=True)

# TalkingHead's add-on, for its scale and bone-roll helpers (functions only).
spec = importlib.util.spec_from_file_location("talkinghead_addon", os.path.join(HERE, "talkinghead-addon.py"))
th = importlib.util.module_from_spec(spec)
spec.loader.exec_module(th)

def step(name):
    print(f"STEP {name}", flush=True)

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

step("human")
# The rig is fitted to the body, so its rest rotations follow the body's
# posture -- and TalkingHead's standing pose replaces those rotations with
# its own, tuned on near-default MakeHuman proportions. Staying close to the
# defaults keeps the rest and the pose in agreement; only the gender moves.
macro = {
    "gender": 1.0, "age": 0.5, "muscle": 0.5, "weight": 0.5, "proportions": 0.5,
    "height": 0.5, "cupsize": 0.5, "firmness": 0.5,
    "race": {"asian": 0.2, "caucasian": 0.5, "african": 0.3},
}
# Knobs: HEAD_GENDER=0 builds a woman, HEAD_AGE, HEAD_MUSCLE, HEAD_WEIGHT,
# HEAD_PROPORTIONS and HEAD_HEIGHT take 0..1 like MakeHuman's sliders.
for key in ("gender", "age", "muscle", "weight", "proportions", "height"):
    if os.environ.get("HEAD_" + key.upper()):
        macro[key] = float(os.environ["HEAD_" + key.upper()])
basemesh = HumanService.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                                     feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
basemesh.name = "Enio"

step("rig")
rig = Rig.from_json_file_and_basemesh(os.path.join(HERE, "talkinghead.mpfbskel"), basemesh)
armature = rig.create_armature_and_fit_to_basemesh()
armature.name = armature.data.name = "Armature"
RigService.normalize_rotation_mode(armature)
basemesh.parent = armature
armature.location = basemesh.location
basemesh.location = (0.0, 0.0, 0.0)
RigService.load_weights(armature, basemesh, os.path.join(HERE, "talkinghead.mhw"))
RigService.ensure_armature_modifier(basemesh, armature)

step("skin")
HumanService.set_character_skin(os.path.join(DATA, "skins/young_caucasian_male/young_caucasian_male.mhmat"),
                                basemesh, skin_type="GAMEENGINE", material_instances=False)

step("assets")
def asset(rel, atype, **kw):
    return HumanService.add_mhclo_asset(os.path.join(DATA, rel), basemesh, asset_type=atype, subdiv_levels=0,
                                        material_type="GAMEENGINE", **kw)
asset("eyes/high-poly/high-poly.mhclo", "Eyes")
asset("eyebrows/eyebrow001/eyebrow001.mhclo", "Eyebrows")
asset("eyelashes/eyelashes01/eyelashes01.mhclo", "Eyelashes")
asset("teeth/teeth_base/teeth_base.mhclo", "Teeth")
asset("tongue/tongue01/tongue01.mhclo", "Tongue")
asset("hair/short02/short02.mhclo", "Hair")
# The plain white shirt rather than the plaid default; the key is the mhclo's uuid.
asset("clothes/male_casualsuit01/male_casualsuit01.mhclo", "Clothes",
      alternative_materials={"79ced554-1d8a-4c14-a6a8-e1de90b09c32":
                             "male_casualsuit01/toigo_male_casual_suit_01_white_shirt/toigo_male_casual_suit_01_white_shirt.mhmat"})
asset("clothes/shoes01/shoes01.mhclo", "Clothes")

step("export copy")
copy_root = ExportService.create_character_copy(basemesh, name_suffix="_export")
new_basemesh = ObjectService.find_object_of_type_amongst_nearest_relatives(copy_root)
TargetService.bake_targets(new_basemesh)
FaceService.load_targets(new_basemesh, load_microsoft_visemes=False, load_meta_visemes=True, load_arkit_faceunits=True)
FaceService.interpolate_targets(new_basemesh)
ExportService.bake_modifiers_remove_helpers(new_basemesh, bake_masks=True, bake_subdiv=True, remove_helpers=True)

step("cleanup originals")
new_root = new_basemesh.parent if new_basemesh.parent else new_basemesh
keep = set([new_root] + ObjectService.get_list_of_children(new_root))
for o in list(bpy.data.objects):
    if o not in keep:
        bpy.data.objects.remove(o, do_unlink=True)
new_arm = new_root if new_root.type == "ARMATURE" else None
if new_arm is None:
    raise RuntimeError("the export copy has no armature root")
new_arm.name = new_arm.data.name = "Armature"

step("talkinghead scale + bone axes")
bpy.ops.object.select_all(action="DESELECT")
new_arm.select_set(True)
bpy.context.view_layer.objects.active = new_arm
th.scale_character([new_arm], "Hips", 1.0)
# The bone-roll fix is for rigs that came from elsewhere; TalkingHead's own
# rig file already carries its axes, and re-rolling the head and neck without
# the eye bones left the eyes and the gaze pointing the wrong way.
if os.environ.get("HEAD_FIX_BONE_AXES", "1") == "1":
    th.fix_bone_axes([new_arm], th.BONE_AXES_DATA_A)
bpy.ops.object.mode_set(mode="OBJECT")

step("rest pose to TalkingHead's standing pose")
# TalkingHead poses a character by REPLACING the spine, neck and head
# rotations with absolute values tuned on near-default MakeHuman bodies.
# MPFB fits the rig to the body, and a male body fits a wavy chain (neck
# bent back, head tilted forward) that those values then fight: the neck
# juts, the head tilts. glTF records only joint positions and orientations,
# so each bone can be re-oriented about its own head to the pose's
# orientation without moving a joint or a vertex; the pose then lands as a
# near-zero delta and the modelled posture is what shows.
from mathutils import Matrix, Vector
SIDE = {  # the library's default pose, Euler XYZ in glTF (Y-up) space
    "Hips": (-0.003, -0.017, 0.1), "Spine": (-0.103, -0.002, -0.063), "Spine1": (0.042, -0.02, -0.069),
    "Spine2": (0.131, -0.012, -0.065), "Neck": (0.027, 0.006, 0.0), "Head": (0.077, -0.065, 0.0),
}
C = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))  # Blender (x, y, z) -> glTF (x, z, -y)
def three_xyz(ex, ey, ez):  # three.js Euler 'XYZ': Rx @ Ry @ Rz
    return Matrix.Rotation(ex, 3, "X") @ Matrix.Rotation(ey, 3, "Y") @ Matrix.Rotation(ez, 3, "Z")
bpy.ops.object.select_all(action="DESELECT")
new_arm.select_set(True)
bpy.context.view_layer.objects.active = new_arm
bpy.ops.object.mode_set(mode="EDIT")
ebones = new_arm.data.edit_bones
world_g = Matrix.Identity(3)
for name in ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"]:
    world_g = world_g @ three_xyz(*SIDE[name])
    # The exporter keeps a bone's own X/Y/Z labels and converts only the
    # armature-space coordinates, so the Blender matrix is C^-1 R, not C^-1 R C.
    rb = C.inverted() @ world_g
    b = ebones[name]
    for child in b.children:
        child.use_connect = False
    head_pos = b.head.copy()
    length = b.length
    b.tail = head_pos + (rb @ Vector((0, 1, 0))) * length
    b.align_roll(rb @ Vector((0, 0, 1)))
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.object.select_all(action="DESELECT")
for o in keep:
    o.select_set(True)
bpy.context.view_layer.objects.active = new_arm
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

step("report")
for o in sorted(keep, key=lambda x: x.name):
    sk = o.data.shape_keys.key_blocks if o.type == "MESH" and o.data.shape_keys else []
    names = [k.name for k in sk]
    print(f"OBJ {o.name} type={o.type} verts={len(o.data.vertices) if o.type=='MESH' else '-'} shapekeys={len(names)}")
if new_arm:
    bones = {b.name for b in new_arm.data.bones}
    print("BONES", len(bones), "LeftEye" in bones, "RightEye" in bones, "Hips" in bones)

step("materials")
# Every MakeHuman material arrives with its texture's alpha wired into the
# shader, which the glTF exporter turns into alphaMode BLEND -- a face you can
# see the teeth through. Skin, eyes, teeth, tongue and clothes are opaque;
# hair, brows and lashes are cut-outs, which the exporter emits as MASK when
# the alpha passes through a GREATER_THAN node.
CUTOUT = ("eyebrow", "eyelash", "short02", "hair")
for o in keep:
    if o.type != "MESH":
        continue
    cutout = any(k in o.name.lower() for k in CUTOUT)
    for slot in o.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        tree = mat.node_tree
        bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        alpha = bsdf.inputs["Alpha"]
        if not cutout:
            for link in list(alpha.links):
                tree.links.remove(link)
            alpha.default_value = 1.0
            mat.use_backface_culling = True
        elif alpha.links and alpha.links[0].from_node.type != "MATH":
            # Read the source socket before the link object is freed.
            from_socket = alpha.links[0].from_socket
            tree.links.remove(alpha.links[0])
            clip = tree.nodes.new("ShaderNodeMath")
            clip.operation = "GREATER_THAN"
            clip.inputs[1].default_value = 0.5
            tree.links.new(from_socket, clip.inputs[0])
            tree.links.new(clip.outputs[0], alpha)
        print(f"MAT {o.name}: {mat.name} {'cutout' if cutout else 'opaque'}")

step("export")
bpy.ops.object.select_all(action="DESELECT")
for o in keep:
    o.select_set(True)
bpy.context.view_layer.objects.active = new_arm
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_animations=False,
                          export_morph=True, export_morph_normal=False, export_morph_tangent=False,
                          export_skins=True, export_apply=False, export_yup=True, export_materials="EXPORT",
                          export_image_format="AUTO")
print("WROTE", OUT, os.path.getsize(OUT))
