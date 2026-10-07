.PHONY: all package install clean
all: package
package:
	makepkg --syncdeps --cleanbuild
install: package
	makepkg --install
clean:
	rm -rf -- pkg src
