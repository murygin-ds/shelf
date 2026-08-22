package envelope

import (
	"encoding/binary"
	"errors"
)

const (
	// PadBlock is the block a note body is padded to, so that the length of what the
	// database stores says nothing about the length of the text.
	PadBlock = 4096

	// PadUpdateBlock is the block for one live-editing update. A body is padded to
	// PadBlock; an update is a keystroke or two sent several times a second, and rounding
	// each one to 4 KiB would cost two hundred times the traffic for a property the timing
	// of the frames already gives away.
	PadUpdateBlock = 256
)

var errTruncated = errors.New("padded payload is truncated")

// pad frames the payload with its length and rounds the result up to a block boundary.
func pad(payload []byte, block int) []byte {
	framed := 4 + len(payload)

	size := (framed + block - 1) / block * block
	out := make([]byte, size)

	binary.BigEndian.PutUint32(out, uint32(len(payload)))
	copy(out[4:], payload)

	return out
}

func unpad(padded []byte) ([]byte, error) {
	if len(padded) < 4 {
		return nil, errTruncated
	}

	length := int(binary.BigEndian.Uint32(padded))
	if length > len(padded)-4 {
		return nil, errors.New("padded payload declares an impossible length")
	}

	return padded[4 : 4+length], nil
}
