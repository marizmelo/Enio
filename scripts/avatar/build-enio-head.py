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
# HEAD_PROPORTIONS and HEAD_HEIGHT take 0..1 like MakeHuman's sliders;
# HEAD_EYE_OPEN, HEAD_LID_FOLLOW and HEAD_BLINK_LOWER are the eye tuning below.
for key in ("gender", "age", "muscle", "weight", "proportions", "height"):
    if os.environ.get("HEAD_" + key.upper()):
        macro[key] = float(os.environ["HEAD_" + key.upper()])
basemesh = HumanService.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                                     feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
basemesh.name = "Enio"

# TalkingHead parks the idle gaze a little below the camera (its eye-contact
# rule derives it from the head's pitch, about 0.35 down in its own pose) and
# rides its blink on top of that, so a face spends its idle life with the lids
# a quarter down. MakeHuman's default male opening is two millimetres shorter
# than the example head the library was tuned on, and at that operating point
# it read as asleep. The eye-height target lifts the upper margin and lowers
# the lower one; 0.6 puts the resting opening where the example's is.
EYE_OPEN = float(os.environ.get("HEAD_EYE_OPEN", "0.6"))
if EYE_OPEN:
    for side in ("l", "r"):
        TargetService.load_target(basemesh, TargetService.target_full_path(f"{side}-eye-height2-incr"), weight=EYE_OPEN)

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

# TalkingHead was tuned on Ready Player Me heads, whose eyeLookDown turns the
# eyeball and leaves the lids alone: the library adds the lid-follow itself
# (eyeBlink = max(anim, (eyesLookDown + browDown) / 2)). MakeHuman's face
# units move the lid with the eye as well, so the lid dropped twice, and the
# library's idle gaze closed the eye to a slit. Keep a third of the lid motion
# for a hint of follow; the rest is the library's job. The same pack's blink
# lifts the lower lid 8 mm, which the permanent coupled blink turned into a
# squint: blink from the top, as the library assumes. Only body vertices are
# touched -- the face units also move the eye helpers, which is where the
# eyeball's own rotation is interpolated from, and that must stay whole. This
# runs before the interpolation so lashes and brows follow the scaled lids.
def scale_shape_key(obj, name, factor, only, select=None):
    kb = obj.data.shape_keys.key_blocks.get(name) if obj.data.shape_keys else None
    if kb is None:
        return 0
    ref, n = kb.relative_key, 0
    for i in only:
        d = kb.data[i].co - ref.data[i].co
        if d.length_squared < 1e-14 or (select and not select(d)):
            continue
        kb.data[i].co = ref.data[i].co + d * factor
        n += 1
    return n
body_group = new_basemesh.vertex_groups.get("body")
if body_group is None:
    raise SystemExit("basemesh has no 'body' vertex group; cannot tell lids from eye helpers")
body_verts = [v.index for v in new_basemesh.data.vertices if any(g.group == body_group.index for g in v.groups)]
LID_FOLLOW = float(os.environ.get("HEAD_LID_FOLLOW", "0.3"))
BLINK_LOWER = float(os.environ.get("HEAD_BLINK_LOWER", "0.3"))
for name in ("eyeLookDownLeft", "eyeLookDownRight", "eyeLookUpLeft", "eyeLookUpRight"):
    print("LID", name, scale_shape_key(new_basemesh, name, LID_FOLLOW, body_verts), flush=True)
for name in ("eyeBlinkLeft", "eyeBlinkRight"):
    print("BLINK", name, scale_shape_key(new_basemesh, name, BLINK_LOWER, body_verts, select=lambda d: d.z > 0), flush=True)
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
# see the teeth through. So each part gets the alpha mode its texture means:
# skin, teeth, tongue and clothes are opaque; the eye texture's alpha is the
# cornea, so the eyes clip like TalkingHead's own example (MASK, two-sided);
# hair clips at a low threshold so strands survive; brows and lashes have
# their texture alpha multiplied up first (nine tenths of those textures sit
# below 0.2, so a clip at any threshold ate the strands and a blend sorted
# them behind the skin) and then clip at the same low threshold. Hair, brows
# and lashes are also darkened through a multiply node, which the exporter
# writes as the base colour factor: a black-haired head, one texture.
from mathutils import Matrix, Vector  # noqa: F811 (already imported above)
HAIR_COLOR = tuple(float(x) for x in os.environ.get("HEAD_HAIR_RGB", "0.07,0.06,0.06").split(","))
def kind_of(obj):
    n = obj.name.lower()
    if "eyebrow" in n or "eyelash" in n:
        return "fine"
    if "high-poly" in n or "low-poly" in n or ".eyes" in n:
        return "eyes"
    if any(k in n for k in ("hair", "short0", "bob0", "long0", "ponytail", "braid", "afro")):
        return "hair"
    return "opaque"
def darken(tree, bsdf, rgb):
    base = bsdf.inputs["Base Color"]
    if not base.links:
        base.default_value = (*rgb, 1.0)
        return
    from_socket = base.links[0].from_socket
    tree.links.remove(base.links[0])
    mix = tree.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    mix.inputs[7].default_value = (*rgb, 1.0)  # B: the constant colour
    tree.links.new(from_socket, mix.inputs[6])  # A: the texture
    tree.links.new(mix.outputs[2], base)
def boost_alpha(tree, bsdf, gain):
    """Bake an alpha gain into the texture itself. MakeHuman's brow and lash
    textures are over 85% transparent with faint strands; at any clip
    threshold they vanish and blended they read as pencil lines. A Math node
    between the texture and the Alpha socket would hide the texture from the
    glTF exporter, so the gain is applied to the pixels and saved beside the
    cache, and the material points at the new image."""
    base = bsdf.inputs["Base Color"]
    src = base.links[0].from_node if base.links else None
    while src is not None and src.type != "TEX_IMAGE":
        src = src.inputs[6].links[0].from_node if src.type == "MIX" and src.inputs[6].links else None
    if src is None or src.image is None:
        return
    img = src.image
    boosted = img.copy()
    px = list(img.pixels)
    for i in range(3, len(px), 4):
        px[i] = min(1.0, px[i] * gain)
    boosted.pixels = px
    boosted.name = f"{img.name}-alpha{gain:g}"
    boosted.filepath_raw = os.path.join(CACHE, f"{boosted.name}.png")
    boosted.file_format = "PNG"
    boosted.save()
    src.image = boosted

def clip(tree, bsdf, threshold):
    alpha = bsdf.inputs["Alpha"]
    if not alpha.links or alpha.links[0].from_node.type == "MATH":
        return
    from_socket = alpha.links[0].from_socket
    tree.links.remove(alpha.links[0])
    node = tree.nodes.new("ShaderNodeMath")
    node.operation = "GREATER_THAN"
    node.inputs[1].default_value = threshold
    tree.links.new(from_socket, node.inputs[0])
    tree.links.new(node.outputs[0], alpha)
for o in keep:
    if o.type != "MESH":
        continue
    kind = kind_of(o)
    for slot in o.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        tree = mat.node_tree
        bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        alpha = bsdf.inputs["Alpha"]
        if kind == "opaque":
            for link in list(alpha.links):
                tree.links.remove(link)
            alpha.default_value = 1.0
            mat.use_backface_culling = True
        elif kind == "eyes":
            clip(tree, bsdf, 0.5)
            mat.use_backface_culling = False
        elif kind == "hair":
            clip(tree, bsdf, 0.3)
            mat.use_backface_culling = False
            darken(tree, bsdf, HAIR_COLOR)
        else:  # fine: brows and lashes, strands made to show, then clipped
            boost_alpha(tree, bsdf, 3.0 if "eyebrow" in o.name.lower() else 2.0)
            clip(tree, bsdf, 0.3)
            mat.use_backface_culling = False
            darken(tree, bsdf, HAIR_COLOR)
        print(f"MAT {o.name}: {mat.name} {kind}")

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
