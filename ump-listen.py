#!/usr/bin/env python3
"""
ump-listen.py  —  stage 1 of the Flex Data → Ensemble Room adapter.

Subscribes to a CoreMIDI **MIDI 2.0** source (default: "UG Flex Data", the
virtual source created by Athan's ug-ump-bridge.py) with protocol 2.0, so
Flex Data survives intact (it does NOT survive CoreMIDI's UMP→MIDI1
translation), and re-emits each UMP message as one JSON line
`[w0, w1, w2, w3]` to every WebSocket client on ws://127.0.0.1:8766.

Only Flex Data (Message Type 0xD) is forwarded; other message types are
counted and reported. The source may disappear and reappear (bridge
restarts): a 2-second poll reconnects by display name.

IMPLEMENTATION NOTE (deviation from the original plan's pyobjc sketch):
MIDIInputPortCreateWithProtocol requires an Objective-C *block* callback.
Instead of adding a pyobjc dependency (not installed here, and its handling
of the variable-length MIDIEventList struct is uncertain), this file builds
the block literal by hand with ctypes — same zero-dependency CoreMIDI style
as Athan's own ug-ump-bridge.py. Only `websockets` is required (already
installed for his bridge).

USAGE:
    python3 ump-listen.py --list            # enumerate MIDI sources
    python3 ump-listen.py                   # listen to "UG Flex Data"
    python3 ump-listen.py --source "Name"   # any MIDI 2.0 source, by name
"""
import sys, json, asyncio, ctypes, argparse, time

if sys.platform != "darwin":
    sys.exit("This listener requires macOS (CoreMIDI). Detected: " + sys.platform)

# --------------------------------------------------------------- CoreMIDI (ctypes)
cm = ctypes.CDLL("/System/Library/Frameworks/CoreMIDI.framework/CoreMIDI")
cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib")

c_uint32, c_uint64, c_int32 = ctypes.c_uint32, ctypes.c_uint64, ctypes.c_int32
c_void_p, c_ulong = ctypes.c_void_p, ctypes.c_ulong
kCFStringEncodingUTF8 = 0x08000100
kMIDIProtocol_2_0 = 2

cf.CFStringCreateWithCString.restype = c_void_p
cf.CFStringCreateWithCString.argtypes = [c_void_p, ctypes.c_char_p, c_uint32]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFStringGetCString.argtypes = [c_void_p, ctypes.c_char_p, ctypes.c_long, c_uint32]
def cfstr(s): return cf.CFStringCreateWithCString(None, s.encode("utf-8"), kCFStringEncodingUTF8)

cm.MIDIClientCreate.restype = c_int32
cm.MIDIClientCreate.argtypes = [c_void_p, c_void_p, c_void_p, ctypes.POINTER(c_uint32)]
cm.MIDIInputPortCreateWithProtocol.restype = c_int32
cm.MIDIInputPortCreateWithProtocol.argtypes = [c_uint32, c_void_p, c_int32, ctypes.POINTER(c_uint32), c_void_p]
cm.MIDIPortConnectSource.restype = c_int32
cm.MIDIPortConnectSource.argtypes = [c_uint32, c_uint32, c_void_p]
cm.MIDIPortDisconnectSource.restype = c_int32
cm.MIDIPortDisconnectSource.argtypes = [c_uint32, c_uint32]
cm.MIDIGetNumberOfSources.restype = c_ulong
cm.MIDIGetSource.restype = c_uint32
cm.MIDIGetSource.argtypes = [c_ulong]
cm.MIDIObjectGetStringProperty.restype = c_int32
cm.MIDIObjectGetStringProperty.argtypes = [c_uint32, c_void_p, ctypes.POINTER(c_void_p)]

# CoreMIDI only refreshes a client's view of the MIDI setup (sources appearing/
# disappearing) when the run loop of the thread that created the MIDIClient
# processes its setup-change notifications. asyncio never pumps the CFRunLoop,
# so without this the source list goes stale after the first snapshot and a
# restarted bridge is never re-discovered. Pump briefly before each poll.
cf.CFRunLoopRunInMode.restype = c_int32
cf.CFRunLoopRunInMode.argtypes = [c_void_p, ctypes.c_double, ctypes.c_bool]
_kCFRunLoopDefaultMode = c_void_p.in_dll(cf, "kCFRunLoopDefaultMode")

def pump_runloop(seconds=0.05):
    """Process pending CFRunLoop events on this thread (MIDI setup notifications)."""
    cf.CFRunLoopRunInMode(_kCFRunLoopDefaultMode, seconds, False)

def obj_name(obj):
    s = c_void_p()
    prop = c_void_p.in_dll(cm, "kMIDIPropertyDisplayName")
    if cm.MIDIObjectGetStringProperty(obj, prop, ctypes.byref(s)) != 0 or not s.value:
        return "?"
    buf = ctypes.create_string_buffer(256)
    if cf.CFStringGetCString(s.value, buf, 256, kCFStringEncodingUTF8):
        return buf.value.decode("utf-8", "replace")
    return "?"

def list_sources():
    return [(i, cm.MIDIGetSource(c_ulong(i)), obj_name(cm.MIDIGetSource(c_ulong(i))))
            for i in range(cm.MIDIGetNumberOfSources())]

# --------------------------------------------------- Objective-C block (by hand)
# CoreMIDI's MIDIReceiveBlock is an ObjC block:
#   void (^)(const MIDIEventList *evtlist, void *srcConnRefCon)
# A block is a struct whose invoke function receives the block pointer as
# its first argument. A GLOBAL block (BLOCK_IS_GLOBAL) is never copied, so
# no copy/dispose helpers are needed.
BLOCK_IS_GLOBAL = 1 << 28
RECV_CFUNC = ctypes.CFUNCTYPE(None, c_void_p, c_void_p, c_void_p)  # (block, evtlist*, refCon)

class BlockDescriptor(ctypes.Structure):
    _fields_ = [("reserved", c_ulong), ("size", c_ulong)]

class BlockLiteral(ctypes.Structure):
    _fields_ = [("isa", c_void_p), ("flags", c_int32), ("reserved", c_int32),
                ("invoke", c_void_p), ("descriptor", ctypes.POINTER(BlockDescriptor))]

_keepalive = []  # the block, its descriptor and CFUNCTYPE must outlive the port

def make_receive_block(py_callback):
    cfunc = RECV_CFUNC(lambda _blk, evtlist, _ref: py_callback(evtlist))
    desc = BlockDescriptor(0, ctypes.sizeof(BlockLiteral))
    isa_sym = (c_void_p * 1).in_dll(libsystem, "_NSConcreteGlobalBlock")
    block = BlockLiteral(
        ctypes.addressof(isa_sym), BLOCK_IS_GLOBAL, 0,
        ctypes.cast(cfunc, c_void_p), ctypes.pointer(desc),
    )
    _keepalive.extend([cfunc, desc, block])
    return ctypes.byref(block)

# ------------------------------------------------------- MIDIEventList parsing
# struct MIDIEventList { MIDIProtocolID protocol (4); UInt32 numPackets (4);
#                        MIDIEventPacket packet[]; }
# struct MIDIEventPacket { MIDITimeStamp timeStamp (8); UInt32 wordCount (4);
#                          UInt32 words[wordCount]; }   (packets are packed)
UMP_WORDS_BY_MT = {0x0: 1, 0x1: 1, 0x2: 1, 0x3: 2, 0x4: 2, 0x5: 4, 0x6: 1, 0x7: 1,
                   0x8: 2, 0x9: 2, 0xA: 2, 0xB: 3, 0xC: 3, 0xD: 4, 0xE: 4, 0xF: 4}

def parse_eventlist(ptr):
    """Yield lists of 32-bit words, one per UMP *message* (not per packet)."""
    base = ptr
    num_packets = c_uint32.from_address(base + 4).value
    off = 8
    for _ in range(num_packets):
        word_count = c_uint32.from_address(base + off + 8).value
        if word_count > 64:  # corrupt; bail out of this list
            return
        words = list((c_uint32 * word_count).from_address(base + off + 12))
        off += 12 + 4 * word_count
        i = 0
        while i < len(words):
            mt = (words[i] >> 28) & 0xF
            n = UMP_WORDS_BY_MT.get(mt, len(words) - i)
            yield [w & 0xFFFFFFFF for w in words[i:i + n]]
            i += n

# ------------------------------------------------------------------- listener
class Listener:
    def __init__(self, source_name):
        self.source_name = source_name
        self.connected_ref = None
        self.client = c_uint32()
        if cm.MIDIClientCreate(cfstr("Flex Adapter Listen"), None, None, ctypes.byref(self.client)) != 0:
            raise RuntimeError("MIDIClientCreate failed")
        self.port = c_uint32()
        block = make_receive_block(self._on_events)
        st = cm.MIDIInputPortCreateWithProtocol(
            self.client, cfstr("Flex Adapter In"), kMIDIProtocol_2_0, ctypes.byref(self.port), block)
        if st != 0:
            raise RuntimeError(f"MIDIInputPortCreateWithProtocol failed (OSStatus {st}); needs macOS 11+")
        self.on_ump = None          # set by the WS side; called from the MIDI thread
        self.counts = {"flex": 0, "other": {}}

    def _on_events(self, evtlist_ptr):
        try:
            for words in parse_eventlist(evtlist_ptr):
                if not words:
                    continue
                mt = (words[0] >> 28) & 0xF
                if mt == 0xD:
                    self.counts["flex"] += 1
                    if self.on_ump:
                        self.on_ump(words)
                else:
                    self.counts["other"][mt] = self.counts["other"].get(mt, 0) + 1
        except Exception as e:  # never let an exception cross into CoreMIDI
            print("[listen] parse error:", e, file=sys.stderr)

    def find_source(self):
        want = self.source_name.lower()
        for _i, ref, name in list_sources():
            if want in name.lower():
                return ref, name
        return None, None

    def poll_connect(self):
        """Connect/reconnect to the named source; returns a status string on change."""
        ref, name = self.find_source()
        if ref == self.connected_ref:
            return None
        if self.connected_ref is not None:
            cm.MIDIPortDisconnectSource(self.port, self.connected_ref)
            self.connected_ref = None
            if ref is None:
                return f'source "{self.source_name}" disappeared — waiting for it to return'
        if ref is not None:
            st = cm.MIDIPortConnectSource(self.port, ref, None)
            if st == 0:
                self.connected_ref = ref
                return f'connected to source "{name}"'
            return f'MIDIPortConnectSource failed (OSStatus {st})'
        return None

# ---------------------------------------------------------------- WS server
async def run(listener, host, port):
    try:
        import websockets
    except ImportError:
        sys.exit("Missing dependency. Run:  python3 -m pip install --user websockets")

    loop = asyncio.get_running_loop()
    clients = set()
    queue = asyncio.Queue()
    forwarded = [0]

    # Called on the CoreMIDI receive thread → hop to the asyncio loop.
    def on_ump(words):
        loop.call_soon_threadsafe(queue.put_nowait, json.dumps(words))
    listener.on_ump = on_ump

    async def broadcaster():
        while True:
            msg = await queue.get()
            forwarded[0] += 1
            dead = []
            for ws in clients:
                try:
                    await ws.send(msg)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                clients.discard(ws)
            if forwarded[0] % 200 == 0:
                other = ", ".join(f"MT 0x{mt:X}×{n}" for mt, n in sorted(listener.counts["other"].items()))
                print(f"[listen] {forwarded[0]} Flex packets forwarded" + (f"  (not forwarded: {other})" if other else ""))

    async def reconnector():
        while True:
            # Must run on this (main) thread: MIDI setup notifications are
            # delivered to the run loop of the thread that created the client.
            pump_runloop()
            msg = listener.poll_connect()
            if msg:
                print("[listen]", msg)
            await asyncio.sleep(2)

    async def handler(ws, *args):
        peer = getattr(ws, "remote_address", "?")
        clients.add(ws)
        print(f"[listen] console connected ({len(clients)} client(s))")
        try:
            await ws.wait_closed()
        finally:
            clients.discard(ws)
            print(f"[listen] console disconnected ({len(clients)} client(s))")

    try:
        async with websockets.serve(handler, host, port):
            print(f'[listen] watching for MIDI 2.0 source "{listener.source_name}"')
            print(f"[listen] serving UMP JSON on ws://{host}:{port}   (Ctrl-C to quit)")
            await asyncio.gather(broadcaster(), reconnector())
    except OSError as e:
        if getattr(e, "errno", None) == 48:  # EADDRINUSE
            sys.exit(f"[listen] Port {port} already in use — another listener running?  lsof -ti tcp:{port} | xargs kill")
        raise

def main():
    ap = argparse.ArgumentParser(description="CoreMIDI 2.0 source → local WebSocket UMP relay")
    ap.add_argument("--list", action="store_true", help="list MIDI sources and exit")
    ap.add_argument("--source", default="UG Flex Data", help='source display name to match (default: "UG Flex Data")')
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8766)
    args = ap.parse_args()

    if args.list:
        srcs = list_sources()
        print("MIDI sources:")
        for i, _ref, nm in srcs:
            print(f"  [{i}] {nm}")
        if not srcs:
            print("  (none)")
        return

    try:
        listener = Listener(args.source)
    except Exception as e:
        sys.exit("[listen] setup failed: %s" % e)
    try:
        asyncio.run(run(listener, args.host, args.port))
    except KeyboardInterrupt:
        print("\n[listen] bye")

if __name__ == "__main__":
    main()
