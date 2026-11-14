//go:build !(js && wasm)

package arcade

import (
	"bufio"
	"fmt"
	"os"
)

// Run, off the browser, answers one rulesCall per line of stdin with its
// rulesOut on stdout, so a game can be tried and tested natively:
//
//	echo '{"fn":"init","seats":[]}' | go run .
func Run(newGame NewGame, restore RestoreGame) {
	d := &Dispatcher{New: newGame, Restore: restore}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 64<<20)
	for in.Scan() {
		fmt.Println(d.Dispatch(in.Text()))
	}
}
