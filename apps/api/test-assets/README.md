# Test pictures

`astronaut-320.pgm` is the "astronaut" picture of the scikit-image sample data (a NASA portrait of the astronaut Eileen Collins, in the public
domain as NASA's pictures are), made grey and scaled to 320x320 with `ffmpeg -vf scale=320:320:flags=area -pix_fmt gray`, and written as a binary
PGM (a header and one byte per pixel, which any tool can read and which needs no image decoder).

`src/haar.test.ts` searches it for faces and compares the answer with what OpenCV.js 4.11 finds in the same bytes with the same cascade
(`assets/cascades/haarcascade_frontalface_alt2.xml`), which is how the face detector is known to do what OpenCV does.
