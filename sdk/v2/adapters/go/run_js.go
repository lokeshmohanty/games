//go:build js && wasm

package arcade

import "unsafe"

// The page's glue (arcade-go.js) passes each rules call through linear
// memory: it asks arcade_in for room, writes the call's JSON there, then
// arcade_dispatch answers into a buffer it reads at arcade_out. No goroutines
// or syscall/js, so the module builds with -scheduler=none, half the size of
// the asyncify build that js.FuncOf needs.
var (
	live    *Dispatcher
	in, out []byte
)

// Run hands the game to the platform: call it from main, which then returns.
// The page's glue (arcade-go.js) calls arcade.managedJson with Dispatch once
// main has run; that also says `ready`.
func Run(newGame NewGame, restore RestoreGame) {
	live = &Dispatcher{New: newGame, Restore: restore}
}

//export arcade_in
func arcadeIn(n uint32) unsafe.Pointer {
	in = make([]byte, n+1) // never empty, so the pointer is real
	return unsafe.Pointer(unsafe.SliceData(in))
}

//export arcade_dispatch
func arcadeDispatch(n uint32) uint32 {
	if live == nil {
		out = []byte(fail("arcade: main did not call arcade.Run"))
	} else {
		out = []byte(live.Dispatch(string(in[:n])))
	}
	in = nil
	return uint32(len(out))
}

//export arcade_out
func arcadeOut() unsafe.Pointer {
	if len(out) == 0 {
		return nil
	}
	return unsafe.Pointer(unsafe.SliceData(out))
}
