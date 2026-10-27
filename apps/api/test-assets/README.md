# Test pictures

`astronaut-320.pgm` is the "astronaut" picture of the scikit-image sample data (a NASA portrait of the astronaut Eileen Collins, in the public
domain as NASA's pictures are), made grey and scaled to 320x320 with `ffmpeg -vf scale=320:320:flags=area -pix_fmt gray`, and written as a binary
PGM (a header and one byte per pixel, which any tool can read and which needs no image decoder).

`src/haar.test.ts` searches it for faces and compares the answer with what OpenCV.js 4.11 finds in the same bytes with the same cascade
(`assets/cascades/haarcascade_frontalface_alt2.xml`), which is how the face detector is known to do what OpenCV does.

# A recording of speech

`jfk.wav` is 11 seconds of speech, 16 kHz mono, 16 bit: the end of the inaugural address of President John F. Kennedy ("And so, my fellow Americans, ask
not what your country can do for you, ask what you can do for your country."). It is the sample that comes with the whisper.cpp project
(`samples/jfk.wav` in [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)), copied here unchanged (352,078 bytes). The speech was given by
a President in office, and speeches of that kind are works of the US government and so in the public domain; the status of this particular
recording was not looked into any further than that.

The start-up check of the video tools (`src/toolchain.ts`, step `speech-sample`) lets whisper.cpp listen to it on the machine the service runs on,
to see that the engine's output is understood, that every word has a time, and how long listening takes there. It is used for nothing else.
