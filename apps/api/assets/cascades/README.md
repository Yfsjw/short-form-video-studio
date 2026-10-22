# Face detector data

`haarcascade_frontalface_alt2.xml` is the "frontal face, alt2" cascade from the OpenCV project (`data/haarcascades`), trained by
Rainer Lienhart: a list of 20 stages of small decision trees that `src/haar.ts` evaluates to find faces that look at the camera.
The file is used unchanged, **with the licence notice at its top** (the Intel License Agreement for Open Source Computer Vision
Library, which allows redistribution and use with the notice kept). Keep that notice if the file is copied, and reproduce it in
the documentation of any binary distribution that contains it.

`src/haar.test.ts` checks the detector against OpenCV's own result for the same picture (`test-assets/astronaut-320.pgm`).
