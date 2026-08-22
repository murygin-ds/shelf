package envelope

import "strings"

// Crockford's alphabet: no I, L, O or U, so a fingerprint read aloud survives the trip.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

const (
	fingerprintChars = 16
	fingerprintGroup = 4
)

func base32(src []byte, length int) string {
	var out strings.Builder

	bits, value := 0, 0

	for _, b := range src {
		value = value<<8 | int(b)
		bits += 8

		for bits >= 5 {
			out.WriteByte(crockford[(value>>(bits-5))&31])
			bits -= 5
		}
	}

	if bits > 0 {
		out.WriteByte(crockford[(value<<(5-bits))&31])
	}

	encoded := out.String()
	if length < 0 || length > len(encoded) {
		return encoded
	}

	return encoded[:length]
}

func group(value string, size int, separator byte) string {
	var out strings.Builder

	for i := 0; i < len(value); i += size {
		if i > 0 {
			out.WriteByte(separator)
		}

		out.WriteString(value[i:min(i+size, len(value))])
	}

	return out.String()
}
