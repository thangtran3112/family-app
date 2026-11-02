package cache

import (
	"bytes"
	"compress/flate"
	"errors"
	"io"

	"google.golang.org/protobuf/proto"

	pb "github.com/thangtran3112/family-app/ai-trading/market-data/bridge/gen/marketdata/v1"
)

// A stored value is one tag byte plus the payload: 'R' raw protobuf, 'Z' flate-compressed
// protobuf. Anything else (a truncated write, another format) fails to open and reads as a miss.
const (
	tagRaw   = 'R'
	tagFlate = 'Z'

	compressOver = 512     // payloads larger than this are deflated
	maxStored    = 1 << 20 // a sealed value over 1 MiB is not stored
	maxOpened    = 64 << 20
)

var errCorrupt = errors.New("cache: corrupt value")

func seal(payload []byte) []byte {
	if len(payload) <= compressOver {
		return append([]byte{tagRaw}, payload...)
	}
	var buf bytes.Buffer
	buf.WriteByte(tagFlate)
	w, _ := flate.NewWriter(&buf, flate.BestSpeed) // only an invalid level errors
	_, _ = w.Write(payload)
	_ = w.Close()
	return buf.Bytes()
}

func open(v []byte) ([]byte, error) {
	if len(v) == 0 {
		return nil, errCorrupt
	}
	switch v[0] {
	case tagRaw:
		return v[1:], nil
	case tagFlate:
		out, err := io.ReadAll(io.LimitReader(flate.NewReader(bytes.NewReader(v[1:])), maxOpened))
		if err != nil {
			return nil, errCorrupt
		}
		return out, nil
	}
	return nil, errCorrupt
}

// encodeBars wraps closed bars and their quality in the GetBarsResponse message, so no proto
// change is needed. Served carries only Quality.
func encodeBars(symbol string, bars []*pb.Bar, q pb.Quality) []byte {
	b, _ := proto.Marshal(&pb.GetBarsResponse{Symbol: symbol, Bars: bars, Served: &pb.Served{Quality: q}})
	return seal(b)
}

func decodeBars(v []byte) ([]*pb.Bar, pb.Quality, error) {
	raw, err := open(v)
	if err != nil {
		return nil, 0, err
	}
	var r pb.GetBarsResponse
	if err := proto.Unmarshal(raw, &r); err != nil {
		return nil, 0, errCorrupt
	}
	return r.Bars, r.GetServed().GetQuality(), nil
}

func encodeQuote(q *pb.Quote) []byte {
	b, _ := proto.Marshal(q)
	return seal(b)
}

func decodeQuote(v []byte) (*pb.Quote, error) {
	raw, err := open(v)
	if err != nil {
		return nil, err
	}
	q := &pb.Quote{}
	if err := proto.Unmarshal(raw, q); err != nil || q.Symbol == "" {
		return nil, errCorrupt
	}
	return q, nil
}
